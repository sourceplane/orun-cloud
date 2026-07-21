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
  /**
   * Value provenance discriminator (saas-integration-hub IH7). `"static"` =
   * the value is a stored ciphertext version. `"brokered"` = no stored value;
   * the head envelope is a binding pointer and the value is minted
   * just-in-time from the integrations credential broker at resolve.
   */
  source: "static" | "brokered";
  /** Display-only broker binding fact (IH7): provider slug (e.g. cloudflare).
   * `null` unless `source === "brokered"` (DB CHECK enforces this). */
  bindingProvider: string | null;
  /** Display-only broker binding fact (IH7): raw uuid of the integrations
   * connection the value is minted against. Opaque reference. */
  bindingConnectionId: string | null;
  /** Display-only broker binding fact (IH7): credential template name
   * (e.g. workers-deploy). */
  bindingTemplate: string | null;
  /**
   * Provider-rotation producer (provider-rotated-secrets RS0): integration
   * provider slug (e.g. `cloudflare`) the next value is minted from on the SM6
   * rotation schedule. `null` = not provider-rotated. Present iff
   * `rotationConnectionId` and `rotationTemplate` are (DB CHECK enforces this).
   * A provider-rotated secret is always `source === "static"`.
   */
  rotationProvider: string | null;
  /** Provider-rotation producer (RS0): raw uuid of the integrations connection
   * the next value is minted against. Opaque reference. */
  rotationConnectionId: string | null;
  /** Provider-rotation producer (RS0): credential broker scope template. */
  rotationTemplate: string | null;
  /** Provider-rotation producer (RS0): optional JSON params for the mint. */
  rotationParams: Record<string, unknown> | null;
  /** Provider-rotation producer (RS0): overlap seconds the prior token stays
   * valid after a rotation before revoke. `null` = engine default. */
  rotationGraceSeconds: number | null;
  /** Provider-rotation producer (RS0): optional materialize target the rotated
   * value is re-delivered into for long-lived consumers. `null` = none. */
  rotationDeliverTarget: string | null;
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

/**
 * A secret due for a rotation reminder or expiry warning (saas-secret-manager
 * SEC7). Metadata only — a value NEVER appears. `dueKind` distinguishes an
 * overdue rotation from an approaching/passed expiry; `ageDays` is whole days
 * since the last rotation (or creation when never rotated).
 */
export interface SecretRotationDue {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: ScopeKind;
  secretKey: string;
  rotationPolicy: string | null;
  lastRotatedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  ageDays: number;
  dueKind: "rotation" | "expiry";
}

/**
 * A provider-rotated secret due for an engine rotation (provider-rotated-secrets
 * RS2). Metadata + producer binding only — a value NEVER appears. Due when the
 * rotation_policy interval has elapsed since the last rotation, or when the
 * stored token's expires_at is inside the grace window (the stalled-schedule
 * backstop: rotate before the provider-side token dies).
 */
export interface ProviderRotationDue {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: ScopeKind;
  secretKey: string;
  rotationPolicy: string | null;
  rotationProvider: string;
  rotationConnectionId: string;
  rotationTemplate: string;
  rotationParams: Record<string, unknown> | null;
  rotationGraceSeconds: number | null;
  rotationDeliverTarget: string | null;
  lastRotatedAt: Date | null;
  expiresAt: Date | null;
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
  /** Value provenance discriminator (IH7). Defaults to `"static"`. For a
   * brokered secret the envelope carries the binding pointer; the three
   * binding facts below are display-only and must accompany it (DB CHECK). */
  source?: "static" | "brokered";
  /** Display-only broker binding fact (IH7): provider slug. */
  bindingProvider?: string;
  /** Display-only broker binding fact (IH7): the integrations connection uuid. */
  bindingConnectionId?: Uuid;
  /** Display-only broker binding fact (IH7): credential template name. */
  bindingTemplate?: string;
  /**
   * Provider-rotation producer (provider-rotated-secrets RS1). Omit for a
   * non-rotated secret. When set, the value is an ordinary stored ciphertext
   * (v1) and these columns record how the RS2 engine mints the next version.
   * `rotationProvider`/`rotationConnectionId`/`rotationTemplate` are the
   * all-or-nothing core (DB CHECK); the rest are optional adjuncts.
   */
  rotationProvider?: string;
  rotationConnectionId?: Uuid;
  rotationTemplate?: string;
  rotationParams?: Record<string, unknown>;
  rotationGraceSeconds?: number;
  rotationDeliverTarget?: string;
}

// ── Secret policies (saas-secret-manager SM3, Layer 2) ──────
// Tier-tagged portable SecretPolicy documents. NEVER any secret value — only
// the who/what/where/how conditions the resolve evaluates.

export type SecretPolicyTier = "composition" | "stack" | "intent";

/**
 * A stored SecretPolicy document (saas-secret-manager SM3). The `document` is
 * the validated spec (`{ rules: [...] }`, orun-secrets data-model §4); its
 * tenancy scope comes from `(orgId, projectId)`, not the body. Push is
 * idempotent by `documentHash`.
 */
export interface SecretPolicyRecord {
  id: string;
  orgId: string;
  /** NULL = workspace-wide; else the project the document is scoped to. */
  projectId: string | null;
  name: string;
  tier: SecretPolicyTier;
  source: string;
  document: Record<string, unknown>;
  documentHash: string;
  createdAt: Date;
}

export interface PutSecretPolicyInput {
  id: string;
  orgId: string;
  projectId?: string | null;
  name: string;
  tier: SecretPolicyTier;
  source: string;
  document: Record<string, unknown>;
  documentHash: string;
}

/** Scope of a policy list: the org, and optionally a project (workspace-wide
 *  documents always join). */
export interface SecretPolicyScope {
  orgId: string;
  projectId?: string | null;
}

// ── Secret syncs (saas-secret-manager SM5, materialization provenance) ──
// A record of what a deploy run's materialize step pushed where, at which
// version. References/metadata ONLY — a secret VALUE never appears here.

export type SecretSyncStatus = "synced" | "superseded" | "orphaned";

/**
 * One materialization-provenance row (saas-secret-manager SM5): the value of
 * `secretId`@`version` was written into the provisioned catalog entity
 * `entityRef` on the `target` adapter by deploy run `runId`. `status` tracks the
 * lifecycle: `synced` (current) -> `superseded` (a newer sync replaced it) ->
 * `orphaned` (the entity was decommissioned). NEVER carries a secret value.
 */
export interface SecretSync {
  id: string;
  secretId: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  version: number;
  target: string;
  entityRef: string;
  runId: string;
  status: SecretSyncStatus;
  syncedAt: Date;
}

export interface RecordSecretSyncInput {
  id: string;
  /** Recording scope (org/project/environment) — denormalized onto the row. */
  scope: Scope;
  secretId: string;
  version: number;
  target: string;
  entityRef: string;
  runId: string;
}

/** Metadata-only filters for a sync list: per-entity (`entityRef`),
 *  per-component (`secretId`), and lifecycle (`status`) views. */
export interface ListSecretSyncsFilter {
  entityRef?: string;
  secretId?: string;
  status?: SecretSyncStatus;
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
  /**
   * Fetch a specific wrapped-DEK generation for decrypt (saas-secret-manager
   * SM3). Any state (active/retiring) is decryptable; a shredded generation is
   * unusable. Returns the wrap document text, or `not_found`.
   */
  getWrappedDek(orgId: string, generation: number): Promise<ConfigResult<string>>;
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
  /**
   * brokered-orphan-safety: every ACTIVE brokered secret bound to a connection
   * (public int_ id) — the reverse lookup a connection-revoke guard uses.
   */
  listActiveBrokeredSecretsByConnection(connectionId: string): Promise<ConfigResult<SecretMetadata[]>>;
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
  /**
   * Repoint a brokered secret's binding to a different connection
   * (brokered-orphan-safety, Feature 7) — the recovery path for an orphaned
   * head. Like rotate it is append-not-overwrite: bumps the head version,
   * swaps the binding_* columns + the pointer envelope, and appends the new
   * `(secret_id, version)` row. Matches ONLY an active brokered head — a
   * static or missing head returns `not_found`.
   */
  repointBrokeredSecret(
    orgId: string,
    secretId: string,
    createdBy: Uuid,
    binding: { provider: string; connectionUuid: Uuid; template: string; pointerEnvelope: string },
  ): Promise<ConfigResult<SecretMetadata>>;
  /**
   * Stamp a brokered secret's rotation (SC2): the scoped credential has no
   * stored value/version to bump — rotation rolls the connection's source
   * credential — so this ONLY sets `last_rotated_at = now()` and, when
   * provided, `rotation_policy` (the cadence). Matches ONLY an active brokered
   * head; a static or missing head returns `not_found`. `rotationPolicy`
   * absent leaves the cadence unchanged; explicit `null` clears it.
   */
  touchBrokeredRotation(
    orgId: string,
    secretId: string,
    input: { rotationPolicy?: string | null; stampRotation: boolean },
  ): Promise<ConfigResult<SecretMetadata>>;
  revokeSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>>;
  /** Brokered-secret entitlement gate (IH7): live brokered bindings in the org. */
  countBrokeredSecrets(orgId: string): Promise<ConfigResult<number>>;
  /** Version history, newest first. Metadata only — never ciphertext. */
  listSecretVersions(orgId: string, secretId: string, params: PageQueryParams): Promise<ConfigResult<PagedResult<SecretVersion>>>;
  /**
   * Fetch the raw ciphertext envelope for a specific `(secretId, version)`
   * (saas-secret-manager SM3). This is the ONE read path allowed to touch
   * ciphertext — used only by the lease-bound resolve/reveal decrypt handlers.
   * Returns `not_found` when the version does not exist or is revoked. The
   * returned envelope is the JSON document text; callers must never log it.
   */
  getSecretCiphertext(secretId: string, version: number): Promise<ConfigResult<string>>;
  /** Stamp `last_used_at = now()` on a served secret head (SM3 resolve). */
  touchSecretLastUsed(orgId: string, secretId: string, at: Date): Promise<ConfigResult<void>>;
  /**
   * List the secrets due for a rotation reminder or expiry warning (SEC7 cron).
   * A row is due when EITHER its `rotation_policy` interval has elapsed since the
   * last rotation (or creation when never rotated), OR `expires_at` falls within
   * `now + leadWindowSeconds`. Rows reminded within the last `suppressSeconds`
   * (via `last_reminded_at`) are excluded so a still-due secret is not re-notified
   * every tick. Bounded by `limit`. Metadata only — never a value.
   */
  listSecretsDueForRotation(
    now: Date,
    leadWindowSeconds: number,
    suppressSeconds: number,
    limit: number,
  ): Promise<ConfigResult<SecretRotationDue[]>>;
  /** Stamp `last_reminded_at` on a batch of just-reminded secrets (SEC7 cron idempotency). */
  markSecretsReminded(secretIds: string[], at: Date): Promise<ConfigResult<void>>;
  /**
   * List the provider-rotated secrets due for an engine rotation (RS2 cron).
   * A row is due when its `rotation_policy` interval has elapsed since the last
   * rotation (or creation), OR its `expires_at` is inside the grace window —
   * the stalled-schedule backstop that rotates before the stored token dies
   * provider-side. Only active, shared, provider-rotated (`rotation_provider IS
   * NOT NULL`) heads qualify. Bounded by `limit`. Never a value.
   */
  listSecretsDueForProviderRotation(now: Date, limit: number): Promise<ConfigResult<ProviderRotationDue[]>>;
  /**
   * Complete one engine rotation (RS2): bump the head version, store the new
   * ciphertext envelope, append the version row, stamp `last_rotated_at`, and
   * move `expires_at` to the new token's provider-side expiry — one atomic
   * statement. Guarded to an active provider-rotated static head; anything
   * else returns `not_found` (the engine can never touch a non-rotated
   * secret). Append-only: the prior version row is untouched.
   */
  rotateProviderSecret(
    orgId: string,
    secretId: string,
    createdBy: Uuid,
    ciphertextEnvelope: string,
    expiresAt: Date | null,
  ): Promise<ConfigResult<SecretMetadata>>;

  // Secret policies (SM3, Layer 2)
  /**
   * Upsert a tier-tagged SecretPolicy document by `(org, project, tier, name)`
   * (saas-secret-manager SM3). Idempotent by `documentHash`: an identical
   * document is a no-op; a changed one updates `document` + `document_hash` in
   * place (ON CONFLICT). `updated` reports whether the row changed.
   */
  putSecretPolicy(input: PutSecretPolicyInput): Promise<ConfigResult<{ record: SecretPolicyRecord; updated: boolean }>>;
  /**
   * List the SecretPolicy documents in scope, tier-ordered
   * composition → stack → intent (policy-model §5). Workspace-wide documents
   * (project_id NULL) always join; a project id additionally includes that
   * project's documents.
   */
  listSecretPolicies(scope: SecretPolicyScope): Promise<ConfigResult<SecretPolicyRecord[]>>;

  // Secret syncs (SM5, materialization provenance)
  /**
   * Record a materialization sync (saas-secret-manager SM5) in ONE atomic
   * statement: flip any existing `synced` row for the same
   * `(secretId, target, entityRef)` to `superseded`, then insert the new
   * `synced` row. Idempotent-friendly: if an identical
   * `(secretId, version, target, entityRef, runId)` is already `synced`, the
   * existing row is returned unchanged (no supersede, no duplicate). References
   * only — never a secret value.
   */
  recordSecretSync(input: RecordSecretSyncInput): Promise<ConfigResult<SecretSync>>;
  /**
   * List sync provenance rows in scope, newest first (saas-secret-manager SM5).
   * Metadata only. Supports the catalog facet's per-entity (`entityRef`),
   * per-component (`secretId`), and lifecycle (`status`) views.
   */
  listSecretSyncs(scope: Scope, filter: ListSecretSyncsFilter, params: PageQueryParams): Promise<ConfigResult<PagedResult<SecretSync>>>;
  /**
   * Flip every `synced` row for a decommissioned entity to `orphaned`
   * (saas-secret-manager SM5). Exposed now; the caller (entity removal) is wired
   * later. Returns the number of rows orphaned.
   */
  markSyncsOrphaned(entityRef: string): Promise<ConfigResult<{ count: number }>>;
}
