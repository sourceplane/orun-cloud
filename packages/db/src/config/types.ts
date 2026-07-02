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
  /**
   * Personal-overlay owner (saas-secret-manager SM1). `null` = shared row.
   * When set, this row is a per-user overlay: visible to and serving only this
   * subject, and only at environment scope (DB CHECK enforces this).
   */
  personalOwner: string | null;
  /**
   * Inheritance mode for the scope-resolution chain (saas-secret-manager SM1).
   * `true` (default) = a more-specific scope may override this key. `false` = a
   * locked guardrail a lower scope cannot override. Secrets may be locked at
   * account OR organization scope (DB CHECK; deliberately wider than settings).
   */
  overridable: boolean;
  /** Stamped when a value is served by the resolve path (SM3). */
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // NOTE: ciphertext_envelope is intentionally excluded from the type.
  // It is never exposed through the repository read surface.
}

/**
 * A row of the append-only ciphertext history (saas-secret-manager SM1).
 * NOTE: the envelope is intentionally excluded — version reads are metadata
 * only; only the SM3 resolve/reveal decrypt path may touch ciphertext.
 */
export interface SecretVersion {
  secretId: string;
  version: number;
  status: string;
  createdBy: string;
  createdAt: Date;
}

export interface CreateSecretMetadataInput {
  id: string;
  /** Account scope is a valid secret rung (SM1), unlike settings writes. */
  scope: ResolveScope;
  secretKey: string;
  displayName?: string;
  rotationPolicy?: string;
  expiresAt?: Date;
  /** UUID column `config.secret_metadata.created_by` — must be a decoded `Uuid`,
   * not a public `usr_<hex>` id. Branding makes a missing decode a compile error. */
  createdBy: Uuid;
  /** Personal-overlay owner (environment scope only). Omit for a shared row. */
  personalOwner?: Uuid;
  /** Only meaningful at account/organization scope; defaults to true. */
  overridable?: boolean;
  /** JSON-serialized ciphertext envelope. Write-only — never returned. When
   * present, version 1 is appended to config.secret_versions atomically. */
  ciphertextEnvelope?: string;
}

// ── Secret DEKs (saas-secret-manager SM2) ───────────────────
// NOTE: No raw key material fields. `wrappedDek` is ciphertext under the KEK.

/**
 * A workspace data-encryption key row (saas-secret-manager SM2), keyed
 * `(orgId, generation)` — the unit a v:2 envelope's `keyId`
 * (`ws:<org-uuid>:<generation>`) names. Stored WRAPPED under the KEK; the
 * repository never sees, logs, or returns unwrapped key bytes.
 */
export interface SecretDek {
  orgId: string;
  generation: number;
  /** JSON wrap document `{v, iv, ct}` — DEK ciphertext under the KEK. */
  wrappedDek: string;
  /** 'active' (serving writes), 'retiring' (decrypt-only), or 'shredded'. */
  state: string;
  createdAt: Date;
}

/**
 * Envelope-format census over config.secret_versions — the % of envelopes on
 * workspace DEKs drives the k0 retirement date (orun-secrets R-13).
 */
export interface EnvelopeVersionCounts {
  v1Count: number;
  v2Count: number;
}

export interface SecretDekRepository {
  /** The org's highest active generation, or `not_found` before the first v:2 write. */
  getActiveDek(orgId: string): Promise<ConfigResult<SecretDek>>;
  /**
   * Race-safe insert (`ON CONFLICT DO NOTHING`): `inserted` is false when a
   * concurrent writer won the `(orgId, generation)` slot — callers re-SELECT.
   */
  insertDek(orgId: string, generation: number, wrappedDek: string): Promise<ConfigResult<{ inserted: boolean }>>;
  /** Envelope counts by format version, org-scoped when `orgId` is given. */
  countEnvelopeVersions(orgId?: string): Promise<ConfigResult<EnvelopeVersionCounts>>;
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
  /**
   * Exact-scope management list. Personal-overlay rows are visible only to their
   * owner: pass `viewerSubjectId` (a decoded subject uuid) to include the
   * viewer's own personal rows; without it every personal row is excluded.
   */
  listSecretMetadata(scope: ResolveScope, params: PageQueryParams, viewerSubjectId?: string): Promise<ConfigResult<PagedResult<SecretMetadata>>>;
  getSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>>;
  /**
   * Point lookup of a single live secret head by its exact scope tuple + key
   * (saas-secret-manager SM1) — the secrets mirror of `getSettingByScopeKey`.
   * Backs the chain resolver: each rung is probed with this. With
   * `personalOwner` set it matches only that owner's overlay row; without it,
   * only the shared (`personal_owner IS NULL`) row.
   */
  getSecretMetadataByScopeKey(scope: ResolveScope, key: string, personalOwner?: string): Promise<ConfigResult<SecretMetadata>>;
  /**
   * Rotate = append, never overwrite (SM1): bumps the head version, stamps
   * last_rotated_at, refreshes the head envelope cache when a new envelope is
   * given, and appends the resulting `(secret_id, version)` row to
   * config.secret_versions — one atomic statement.
   */
  rotateSecretMetadata(orgId: string, secretId: string, createdBy: Uuid, ciphertextEnvelope?: string): Promise<ConfigResult<SecretMetadata>>;
  revokeSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>>;
  /** Version history, newest first. Metadata only — never ciphertext. */
  listSecretVersions(orgId: string, secretId: string, params: PageQueryParams): Promise<ConfigResult<PagedResult<SecretVersion>>>;
}
