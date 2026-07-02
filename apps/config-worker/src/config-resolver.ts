/**
 * config-resolver — the scope-resolution chain (saas-workspace-id WID7).
 *
 * Generalizes the existing config nesting (organization/project/environment) plus
 * the `effectiveBillingOrg` up-resolution into one chain so a value set at the
 * ACCOUNT rung is inherited by every workspace under it:
 *
 *   environment -> project -> workspace(org) -> account -> default
 *   (most specific present value wins; fall back upward until a value is found)
 *
 * Read semantics are deliberately simple: the most-specific PRESENT value wins,
 * and the account is just a rung in the chain. A LOCKED account value
 * (`overridable=false`) is enforced on the WRITE path (the create/update setting
 * handlers reject overriding writes); it needs no special handling on read because
 * a more-specific value cannot exist if the write that would have created it was
 * rejected.
 *
 * Account uuid resolution: the account org is `effectiveBillingOrgId(org) =
 * parentOrgId ?? id`, read from the org row via the membership repo's
 * `getOrganizationById`. Fail-soft: if the org fetch fails the chain resolves only
 * environment -> project -> workspace -> default (the account rung is skipped).
 *
 * Designed so feature_flags / secret_metadata can adopt the same shape later —
 * secret_metadata now has (saas-secret-manager SM1, secrets section below);
 * feature_flags remains a follow-up.
 */
import type {
  ConfigRepository,
  ResolveScope,
  Scope,
  ScopeKind,
  SecretMetadata,
  Setting,
} from "@saas/db/config";
import type { MembershipRepository } from "@saas/db/membership";
import { effectiveBillingOrgId } from "@saas/db/membership";

/** The scope rung an effective value was found at, or `default` when none. */
export type ResolutionSource =
  | "organization"
  | "project"
  | "environment"
  | "account"
  | "default";

export interface ResolvedSetting {
  /** The effective value, or `undefined` when nothing was found in the chain. */
  value: unknown;
  /** Which rung the value was found at (`default` when no row exists). */
  source: ResolutionSource;
  /** `false` only when the winning value is a locked account guardrail. */
  overridable: boolean;
  /** The full row the value came from (`null` for the `default` source). */
  setting: Setting | null;
}

/** Just the slice of the config repo the resolver needs. */
type ResolverConfigRepo = Pick<ConfigRepository, "getSettingByScopeKey">;

/** Just the slice of the membership repo the resolver needs (account uuid). */
type ResolverMembershipRepo = Pick<MembershipRepository, "getOrganizationById">;

/**
 * Build the ordered list of rungs to probe, most-specific first, for a request
 * scope. The account rung is appended last (before the implicit `default`) and is
 * resolved from the org row; it is omitted when the account uuid can't be resolved
 * (fail-soft).
 */
function buildChain(scope: Scope, accountId: string | null): ResolveScope[] {
  const chain: ResolveScope[] = [];

  if (scope.kind === "environment") {
    chain.push({ kind: "environment", orgId: scope.orgId, projectId: scope.projectId, environmentId: scope.environmentId });
    chain.push({ kind: "project", orgId: scope.orgId, projectId: scope.projectId });
  } else if (scope.kind === "project") {
    chain.push({ kind: "project", orgId: scope.orgId, projectId: scope.projectId });
  }

  // workspace (org) rung — always present.
  chain.push({ kind: "organization", orgId: scope.orgId });

  // account rung — only when we resolved an account uuid.
  if (accountId) {
    chain.push({ kind: "account", accountId });
  }

  return chain;
}

/**
 * Resolve the account org uuid for a request scope's org. Returns `null`
 * (fail-soft) when the org cannot be fetched, so the caller skips the account rung
 * rather than failing the whole read.
 */
async function resolveAccountId(
  membershipRepo: ResolverMembershipRepo,
  orgId: string,
): Promise<string | null> {
  const orgResult = await membershipRepo.getOrganizationById(orgId);
  if (!orgResult.ok) {
    return null;
  }
  return effectiveBillingOrgId(orgResult.value);
}

/**
 * Walk the scope-resolution chain for `key` and return the effective value with
 * its provenance. Stops at the first rung that has a row.
 */
export async function resolveSetting(
  repo: ResolverConfigRepo,
  membershipRepo: ResolverMembershipRepo,
  scope: Scope,
  key: string,
): Promise<ResolvedSetting> {
  const accountId = await resolveAccountId(membershipRepo, scope.orgId);
  const chain = buildChain(scope, accountId);

  for (const rung of chain) {
    const result = await repo.getSettingByScopeKey(rung, key);
    if (result.ok) {
      const setting = result.value;
      return {
        value: setting.value,
        source: setting.scopeKind,
        overridable: setting.overridable,
        setting,
      };
    }
    // not_found just means "fall back to the next rung"; an internal error also
    // falls through (fail-soft) rather than aborting the whole resolution.
  }

  return { value: undefined, source: "default", overridable: true, setting: null };
}

/**
 * Write-path guardrail (saas-workspace-id WID7). Before writing a
 * workspace/project/environment-scoped value, the create/update handlers call this
 * to find a LOCKED account-scope value for the same key. Returns the locked account
 * `Setting` when one exists (the write must be rejected with 409), otherwise `null`
 * (the write is allowed — including when the account value is overridable, or when
 * the account uuid can't be resolved).
 *
 * The account rung itself is never blocked from writing: an account-scope write is
 * how a guardrail is set in the first place, so callers pass the request scope and
 * this returns `null` for account-scope writes.
 */
export async function findLockedAccountSetting(
  repo: ResolverConfigRepo,
  membershipRepo: ResolverMembershipRepo,
  scope: Scope,
  key: string,
): Promise<Setting | null> {
  const accountId = await resolveAccountId(membershipRepo, scope.orgId);
  if (!accountId) {
    return null;
  }
  const result = await repo.getSettingByScopeKey({ kind: "account", accountId }, key);
  if (!result.ok) {
    return null;
  }
  return result.value.overridable ? null : result.value;
}

// ── Secrets (saas-secret-manager SM1) ───────────────────────
// The secrets variant of the chain above. Same read semantics (most specific
// present head wins; fail-soft account rung), plus a personal rung: the
// viewer's own environment-scope overlay beats the shared environment row.
// Metadata plane only — no values ever flow through the resolver.

/** The rung a secret head serves from. `organization` reads as `workspace`. */
export type SecretServesFrom = "personal" | "environment" | "project" | "workspace" | "account";

export interface ResolvedSecret {
  /** The serving head row, or `null` when no rung has the key. */
  secret: SecretMetadata | null;
  /** Which rung serves (`null` when no row exists anywhere in the chain). */
  servesFrom: SecretServesFrom | null;
  /** `false` only when the serving head is a locked guardrail. */
  overridable: boolean;
}

/** Just the slice of the config repo the secrets resolver needs. */
type SecretResolverRepo = Pick<ConfigRepository, "getSecretMetadataByScopeKey">;

export interface ResolveSecretQuery {
  orgId: string;
  projectId?: string;
  environmentId?: string;
  key: string;
  /** Decoded subject uuid; enables the personal rung (environment scope only). */
  viewerSubjectId?: string;
}

export function secretServesFrom(scopeKind: ScopeKind, personal: boolean): SecretServesFrom {
  if (personal) return "personal";
  if (scopeKind === "organization") return "workspace";
  return scopeKind as SecretServesFrom;
}

/**
 * Walk the secrets scope-resolution chain for `key` and return the serving head
 * with its provenance: personal(environment, viewer) -> environment -> project
 * -> workspace(org) -> account -> null. Stops at the first rung that has a row.
 */
export async function resolveEffectiveSecret(
  deps: { repo: SecretResolverRepo; membershipRepo: ResolverMembershipRepo },
  query: ResolveSecretQuery,
): Promise<ResolvedSecret> {
  const scope: Scope = query.environmentId && query.projectId
    ? { kind: "environment", orgId: query.orgId, projectId: query.projectId, environmentId: query.environmentId }
    : query.projectId
      ? { kind: "project", orgId: query.orgId, projectId: query.projectId }
      : { kind: "organization", orgId: query.orgId };

  // Personal rung — the viewer's own overlay, environment scope only.
  if (scope.kind === "environment" && query.viewerSubjectId) {
    const personal = await deps.repo.getSecretMetadataByScopeKey(scope, query.key, query.viewerSubjectId);
    if (personal.ok) {
      return { secret: personal.value, servesFrom: "personal", overridable: personal.value.overridable };
    }
  }

  const accountId = await resolveAccountId(deps.membershipRepo, query.orgId);
  for (const rung of buildChain(scope, accountId)) {
    const result = await deps.repo.getSecretMetadataByScopeKey(rung, query.key);
    if (result.ok) {
      const secret = result.value;
      return {
        secret,
        servesFrom: secretServesFrom(secret.scopeKind, secret.personalOwner !== null),
        overridable: secret.overridable,
      };
    }
    // not_found / internal errors fall through to the next rung (fail-soft),
    // exactly like the settings resolver above.
  }

  return { secret: null, servesFrom: null, overridable: true };
}

/**
 * Write-path guardrail for secrets (saas-secret-manager SM1). Before writing a
 * scoped secret, the create handler calls this to find a LOCKED
 * (`overridable=false`) row for the same key ABOVE the target scope. Unlike
 * settings (account-only locks), secrets may be locked at the account OR the
 * workspace(org) rung, so both are probed. Returns the locked row (the write
 * must be rejected with 409) or `null` (allowed — including fail-soft when the
 * account uuid can't be resolved). A rung is never blocked by itself: an
 * organization-scope write only probes the account rung.
 */
export async function findLockedSecretAbove(
  repo: SecretResolverRepo,
  membershipRepo: ResolverMembershipRepo,
  scope: Scope,
  key: string,
): Promise<SecretMetadata | null> {
  if (scope.kind === "project" || scope.kind === "environment") {
    const org = await repo.getSecretMetadataByScopeKey({ kind: "organization", orgId: scope.orgId }, key);
    if (org.ok && !org.value.overridable) {
      return org.value;
    }
  }
  const accountId = await resolveAccountId(membershipRepo, scope.orgId);
  if (!accountId) {
    return null;
  }
  const account = await repo.getSecretMetadataByScopeKey({ kind: "account", accountId }, key);
  if (!account.ok) {
    return null;
  }
  return account.value.overridable ? null : account.value;
}
