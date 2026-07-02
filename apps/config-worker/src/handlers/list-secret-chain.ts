import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, ResolveScope, Scope, SecretMetadata } from "@saas/db/config";
import type { MembershipRepository } from "@saas/db/membership";
import { createConfigRepository } from "@saas/db/config";
import { createMembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { effectiveBillingOrgId } from "@saas/db/membership";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, listResponse, validationError } from "../http.js";
import { uuidFromPublicId } from "@saas/db";
import { toChainPublicSecretMetadata } from "../mappers.js";
import { secretServesFrom } from "../config-resolver.js";
import { parsePageParams } from "../pagination.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type { PublicSecretMetadata } from "@saas/contracts/config";

export interface ListSecretChainDeps {
  repo: Pick<ConfigRepository, "listSecretMetadata">;
  membershipRepo: Pick<MembershipRepository, "getOrganizationById">;
}

/**
 * Chain read of the secrets visible from an environment (saas-secret-manager
 * SM1): `GET …/config/secrets?chain=true`. For each key present anywhere in the
 * chain (personal(viewer) -> environment -> project -> workspace(org) ->
 * account) the serving head — the most specific live row — is returned with its
 * `servesFrom` rung and `overridable` flag. Metadata only, never ciphertext.
 * The account rung is fail-soft, like the settings resolver.
 */
export async function handleListSecretChain(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope & { kind: "environment" },
  deps?: ListSecretChainDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const pageResult = parsePageParams(url);
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }
  const { limit, cursor } = pageResult.value;
  const dbCursor = cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null;

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.MEMBERSHIP_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  // Authorization (read)
  if (!deps) {
    const contextResult = await fetchAuthorizationContext(
      env.MEMBERSHIP_WORKER!,
      actor.subjectId,
      actor.subjectType,
      scope.orgId,
      requestId,
    );
    if (!contextResult.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const resource: PolicyResource = { kind: "project", orgId: scope.orgId, projectId: scope.projectId };
    const policyResult = await authorizeViaPolicy(
      env.POLICY_WORKER!,
      actor.subjectId,
      actor.subjectType,
      "secret.read",
      resource,
      contextResult.memberships,
      requestId,
    );
    if (!policyResult.allow) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
  }

  const viewerSubjectId = uuidFromPublicId(actor.subjectId) ?? undefined;

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);
    const membershipRepo = deps?.membershipRepo ?? createMembershipRepository(executor!);

    // Account rung uuid — fail-soft: skipped when the org fetch fails.
    const orgResult = await membershipRepo.getOrganizationById(scope.orgId);
    const accountId = orgResult.ok ? effectiveBillingOrgId(orgResult.value) : null;

    // Most specific rung first: the first live row seen for a key serves it.
    const rungs: ResolveScope[] = [
      scope,
      { kind: "project", orgId: scope.orgId, projectId: scope.projectId },
      { kind: "organization", orgId: scope.orgId },
    ];
    if (accountId) {
      rungs.push({ kind: "account", accountId });
    }

    const page = { limit, cursor: dbCursor };
    const byKey = new Map<string, PublicSecretMetadata>();
    for (const rung of rungs) {
      // The viewer is only passed at the environment rung — personal overlays
      // exist there alone, and a personal row beats the shared row for its key.
      const listed = rung.kind === "environment"
        ? await repo.listSecretMetadata(rung, page, viewerSubjectId)
        : await repo.listSecretMetadata(rung, page);
      if (!listed.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
      const rows = listed.value.items.filter((s: SecretMetadata) => s.status !== "revoked");
      // Within the environment rung, personal overlays shadow shared rows.
      rows.sort((a, b) => Number(b.personalOwner !== null) - Number(a.personalOwner !== null));
      for (const row of rows) {
        if (!byKey.has(row.secretKey)) {
          byKey.set(row.secretKey, toChainPublicSecretMetadata(row, secretServesFrom(row.scopeKind, row.personalOwner !== null)));
        }
      }
    }

    const secrets = [...byKey.values()].sort((a, b) => a.secretKey.localeCompare(b.secretKey));
    // The chain view is a merged read across rungs — no stable cursor exists.
    return listResponse({ secrets }, requestId, null);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
