export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";

// ── Shared scope types ──────────────────────────────────────

export type ScopeKind = "organization" | "project" | "environment" | "account";

/**
 * Account scope (saas-workspace-id WID7). The `accountId` is the effective
 * billing/account org uuid — `effectiveBillingOrgId(org) = parentOrgId ?? id` —
 * resolved by the caller (the config-resolver) from the org row. An account-scope
 * row is the value every workspace under the account inherits via the
 * scope-resolution chain.
 */
export interface AccountScope {
  kind: "account";
  accountId: string;
}

export interface OrgScope {
  kind: "organization";
  orgId: string;
}

export interface ProjectScope {
  kind: "project";
  orgId: string;
  projectId: string;
}

export interface EnvironmentScope {
  kind: "environment";
  orgId: string;
  projectId: string;
  environmentId: string;
}

export type Scope = OrgScope | ProjectScope | EnvironmentScope;

/**
 * A scope usable for resolution / point lookups. Extends the writeable {@link Scope}
 * union with the read-only {@link AccountScope} rung. Writes (create/list) still use
 * {@link Scope}; only the resolver's account-rung lookup uses the account variant.
 */
export type ResolveScope = Scope | AccountScope;

// ── Result type ─────────────────────────────────────────────

export type ConfigRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type ConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConfigRepositoryError };

// ── Cursor pagination (matches existing convention) ─────────

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

// ── Settings ────────────────────────────────────────────────

export interface Setting {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: ScopeKind;
  key: string;
  value: unknown;
  description: string | null;
  /**
   * Inheritance mode for the scope-resolution chain (saas-workspace-id WID7).
   * `true` (default) = a more-specific scope may override this value. `false` =
   * a locked account-scope guardrail a workspace cannot override. Only account-
   * scope rows may be `false` (DB CHECK enforces this).
   */
  overridable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSettingInput {
  id: string;
  scope: Scope;
  key: string;
  value: unknown;
  description?: string;
  /** Only meaningful for an account-scope value; defaults to true (overridable). */
  overridable?: boolean;
}

export interface UpdateSettingInput {
  value: unknown;
  description?: string;
}

// ── Feature flags ───────────────────────────────────────────

export interface FeatureFlag {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: ScopeKind;
  flagKey: string;
  enabled: boolean;
  value: unknown | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFeatureFlagInput {
  id: string;
  scope: Scope;
  flagKey: string;
  enabled?: boolean;
  value?: unknown;
  description?: string;
}

export interface UpdateFeatureFlagInput {
  enabled?: boolean;
  value?: unknown;
  description?: string;
}

// ── Secret metadata ─────────────────────────────────────────
// NOTE: No plaintext secret value fields. Only metadata.

export interface SecretMetadata {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: ScopeKind;
  secretKey: string;
  displayName: string | null;
  status: string;
  version: number;
  rotationPolicy: string | null;
  lastRotatedAt: Date | null;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  // NOTE: ciphertext_envelope is intentionally excluded from the type.
  // It is never exposed through the repository read surface.
}

export interface CreateSecretMetadataInput {
  id: string;
  scope: Scope;
  secretKey: string;
  displayName?: string;
  rotationPolicy?: string;
  expiresAt?: Date;
  /** UUID column `config.secret_metadata.created_by` — must be a decoded `Uuid`,
   * not a public `usr_<hex>` id. Branding makes a missing decode a compile error. */
  createdBy: Uuid;
  /** JSON-serialized ciphertext envelope. Write-only — never returned. */
  ciphertextEnvelope?: string;
}

// ── Repository interface ────────────────────────────────────

export interface ConfigRepository {
  // Settings
  createSetting(input: CreateSettingInput): Promise<ConfigResult<Setting>>;
  updateSetting(orgId: string, settingId: string, input: UpdateSettingInput): Promise<ConfigResult<Setting>>;
  getSetting(orgId: string, settingId: string): Promise<ConfigResult<Setting>>;
  listSettings(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<Setting>>>;
  /**
   * Point lookup of a single setting by its exact scope tuple + key (saas-workspace-id
   * WID7). Backs the scope-resolution chain: the resolver probes each rung
   * (environment -> project -> workspace -> account) with this. Returns `not_found`
   * when no row exists at that exact scope for the key.
   */
  getSettingByScopeKey(scope: ResolveScope, key: string): Promise<ConfigResult<Setting>>;

  // Feature flags
  createFeatureFlag(input: CreateFeatureFlagInput): Promise<ConfigResult<FeatureFlag>>;
  updateFeatureFlag(orgId: string, flagId: string, input: UpdateFeatureFlagInput): Promise<ConfigResult<FeatureFlag>>;
  getFeatureFlag(orgId: string, flagId: string): Promise<ConfigResult<FeatureFlag>>;
  listFeatureFlags(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<FeatureFlag>>>;

  // Secret metadata
  createSecretMetadata(input: CreateSecretMetadataInput): Promise<ConfigResult<SecretMetadata>>;
  listSecretMetadata(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<SecretMetadata>>>;
  getSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>>;
  rotateSecretMetadata(orgId: string, secretId: string, ciphertextEnvelope?: string): Promise<ConfigResult<SecretMetadata>>;
  revokeSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>>;
}
