/**
 * Config, feature-flag, and secret-metadata contract types.
 *
 * These types define the public API request/response shapes for the config-worker
 * surface. Mutation types are included for settings and feature flags.
 * No secret value mutation types are included.
 */

// ---------------------------------------------------------------------------
// Public Setting
// ---------------------------------------------------------------------------

export interface PublicSetting {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: string;
  key: string;
  value: unknown;
  description: string | null;
  /**
   * Inheritance mode (saas-workspace-id WID7). `false` marks a locked account-scope
   * guardrail a workspace cannot override. Optional/absent on surfaces that predate
   * the scope-resolution chain.
   */
  overridable?: boolean;
  /**
   * Provenance on a resolved read (saas-workspace-id WID7): the scope rung the
   * effective value was found at when the chain (environment -> project ->
   * workspace -> account -> default) was walked. `null`/absent on exact-scope
   * management reads where no resolution occurred.
   */
  inheritedFrom?: {
    scopeKind: "organization" | "project" | "environment" | "account" | "default";
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListSettingsResponse {
  settings: PublicSetting[];
}

// ---------------------------------------------------------------------------
// Setting Mutation Requests
// ---------------------------------------------------------------------------

export interface CreateSettingRequest {
  key: string;
  value: unknown;
  description?: string | null;
}

export interface UpdateSettingRequest {
  value: unknown;
  description?: string | null;
}

export interface CreateSettingResponse {
  setting: PublicSetting;
}

export interface UpdateSettingResponse {
  setting: PublicSetting;
}

// ---------------------------------------------------------------------------
// Public Feature Flag
// ---------------------------------------------------------------------------

export interface PublicFeatureFlag {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: string;
  flagKey: string;
  enabled: boolean;
  value: unknown | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListFeatureFlagsResponse {
  featureFlags: PublicFeatureFlag[];
}

// ---------------------------------------------------------------------------
// Feature Flag Mutation Requests
// ---------------------------------------------------------------------------

export interface CreateFeatureFlagRequest {
  flagKey: string;
  enabled?: boolean;
  value?: unknown;
  description?: string | null;
}

export interface UpdateFeatureFlagRequest {
  enabled?: boolean;
  value?: unknown;
  description?: string | null;
}

export interface CreateFeatureFlagResponse {
  featureFlag: PublicFeatureFlag;
}

export interface UpdateFeatureFlagResponse {
  featureFlag: PublicFeatureFlag;
}

// ---------------------------------------------------------------------------
// Public Secret Metadata
// ---------------------------------------------------------------------------
// NOTE: No plaintext value, ciphertext envelope, hash, token, or raw secret
// material may ever appear in this type.

export interface PublicSecretMetadata {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: string;
  secretKey: string;
  displayName: string | null;
  status: string;
  version: number;
  rotationPolicy: string | null;
  lastRotatedAt: string | null;
  expiresAt: string | null;
  createdBy: string;
  /**
   * Inheritance mode (saas-secret-manager SM1). `false` marks a locked guardrail
   * a lower scope cannot override; secrets may be locked at account OR
   * organization scope. Optional/absent on surfaces that predate the chain.
   */
  overridable?: boolean;
  /** `true` when this row is the caller's personal overlay (owner-only visibility). */
  personal?: boolean;
  /** When a value was last served by the resolve path (SM3). */
  lastUsedAt?: string | null;
  /**
   * Provenance on a chain read (saas-secret-manager SM1): the rung the serving
   * head was found at when the chain (personal -> environment -> project ->
   * workspace -> account) was walked. Absent on exact-scope management reads.
   */
  servesFrom?: "personal" | "environment" | "project" | "workspace" | "account";
  /**
   * Value source (saas-integration-hub IH7). `brokered` marks a mint-at-resolve
   * binding — no stored value exists; the envelope is a pointer. Absent on
   * surfaces that predate brokered secrets (treat as `static`).
   */
  source?: "static" | "brokered";
  /**
   * Present when source === "brokered": display-only binding facts for chain
   * provenance (`KEY ← environment (brokered · cloudflare · workers-deploy)`).
   * Never the template params, never credential material.
   */
  binding?: {
    provider: string;
    /** Public connection id (int_…). */
    connectionId: string;
    template: string;
  };
  /**
   * Health of the brokered binding's connection (brokered-orphan-safety).
   * Present only when source === "brokered": a derived projection of the
   * integration connection's lifecycle, computed at read time (never stored,
   * so it can never drift the way `status` did). `unknown` means the
   * connection status could not be read — shown as "health unknown", never as
   * healthy.
   */
  bindingStatus?: "active" | "pending" | "suspended" | "revoked" | "unknown";
  /**
   * `true` when this brokered secret can no longer mint a value because its
   * integration connection is not `active` (revoked / suspended / pending /
   * missing) — an "orphaned" secret. Derived from `bindingStatus`; surfaces
   * identically in the console, `orun secrets` listings, and plan/run resolve.
   * Omitted for static secrets and healthy brokered secrets.
   */
  orphaned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListSecretMetadataResponse {
  secrets: PublicSecretMetadata[];
}

/** One row of the append-only version history. Metadata only — never ciphertext. */
export interface PublicSecretVersion {
  secretId: string;
  version: number;
  status: string;
  createdBy: string;
  createdAt: string;
}

export interface ListSecretVersionsResponse {
  versions: PublicSecretVersion[];
}

// ---------------------------------------------------------------------------
// Secret Metadata Mutation Requests
// ---------------------------------------------------------------------------
// NOTE: The `value` field on CreateSecretRequest and RotateSecretRequest is
// write-only — it is accepted during creation/rotation, encrypted in the
// worker before persistence, and NEVER returned in any response, event, or
// audit payload. No ciphertext, hash, or raw secret material appears in
// responses.

/** Metadata-only secret creation (no encrypted value). */
export interface CreateSecretMetadataRequest {
  secretKey: string;
  displayName?: string | null;
  rotationPolicy?: string | null;
  expiresAt?: string | null;
}

/** Write-only secret creation with an encrypted value. */
export interface CreateSecretRequest {
  secretKey: string;
  /** Write-only secret value. Encrypted before persistence; never returned. */
  value: string;
  displayName?: string | null;
  rotationPolicy?: string | null;
  expiresAt?: string | null;
  /** Lock this key as a guardrail — account/organization scope only (SM1). */
  overridable?: boolean;
  /** Create as the caller's personal overlay — environment scope only (SM1). */
  personal?: boolean;
}

/**
 * Brokered binding pointer (saas-integration-hub IH7): the secret's value is
 * minted just-in-time from the credential broker at resolve, never stored.
 * Creating one requires BOTH `secret.write` and
 * `organization.integration.credential.issue` — you cannot bind authority you
 * could not mint.
 */
export interface SecretBrokerBinding {
  /** Public connection id (int_…) — own or account-shared with admission. */
  connectionId: string;
  /** Scope template id published by the connection's provider. */
  template: string;
  /** Template params (validated against the template's declared params). */
  params?: Record<string, unknown>;
}

/**
 * Brokered secret creation (IH7): `binding` in place of `value`. Mutually
 * exclusive with `value` and with `personal` (a personal overlay can never be
 * brokered).
 */
export interface CreateBrokeredSecretRequest {
  secretKey: string;
  binding: SecretBrokerBinding;
  displayName?: string | null;
  rotationPolicy?: string | null;
  expiresAt?: string | null;
  /** Lock this key as a guardrail — account/organization scope only (SM1). */
  overridable?: boolean;
}

export interface CreateSecretMetadataResponse {
  secret: PublicSecretMetadata;
}

/**
 * Repoint a brokered secret's binding to a different connection
 * (brokered-orphan-safety, Feature 7) — the recovery path for an orphaned head.
 * PATCH .../config/secrets/{id}. `template` is optional: when omitted the
 * secret's existing template is reused (the common "same grant, live
 * connection" move). Value-shaped rotate/reveal never apply to a brokered head.
 */
export interface RepointBrokeredSecretRequest {
  binding: {
    connectionId: string;
    template?: string;
    params?: Record<string, unknown>;
  };
}

/** Write-only secret rotation with a replacement value. */
export interface RotateSecretRequest {
  /** Write-only replacement secret value. Encrypted before persistence; never returned. */
  value: string;
}

/**
 * Rotate a scoped credential (brokered secret) — SC2. Unlike a static rotate
 * there is no value: rotation rolls the connection's org-owned SOURCE
 * credential (Cloudflare service token / Supabase project keys) and stamps
 * `lastRotatedAt`. `rotationPolicy` (a duration like "90d") sets/updates the
 * cadence; `rotate: false` edits the cadence only, without rolling the source.
 */
export interface RotateScopedCredentialRequest {
  rotationPolicy?: string | null;
  rotate?: boolean;
}

export interface RotateSecretMetadataResponse {
  secret: PublicSecretMetadata;
}

export interface RevokeSecretMetadataResponse {
  secret: PublicSecretMetadata;
}

// ---------------------------------------------------------------------------
// Secret Bulk Import (saas-secret-manager SM1)
// ---------------------------------------------------------------------------
// Write-only: each entry's `value` is encrypted before persistence and never
// returned in any response, event, or audit payload.

export interface ImportSecretEntry {
  secretKey: string;
  /** Write-only secret value. Encrypted before persistence; never returned. */
  value: string;
  displayName?: string | null;
}

export interface ImportSecretsRequest {
  /** Up to 100 entries per request. */
  secrets: ImportSecretEntry[];
}

export interface ImportSecretResult {
  secretKey: string;
  status: "created" | "conflict" | "invalid";
}

export interface ImportSecretsResponse {
  results: ImportSecretResult[];
}

// ---------------------------------------------------------------------------
// Key hierarchy status (saas-secret-manager SM2)
// ---------------------------------------------------------------------------

/**
 * Workspace key-hierarchy status: `GET …/config/secrets/key-status` (org
 * scope, `secret.read`). Counts and generation numbers only — never key
 * material or ciphertext.
 */
export interface SecretKeyStatus {
  /** Whether the KEK (SECRET_KEK) is configured, i.e. new writes envelope v:2. */
  kekConfigured: boolean;
  /** The workspace's active DEK generation, or null before its first v:2 write. */
  activeGeneration: number | null;
  /** Stored envelope counts by format version — the k0-retirement metric (orun-secrets R-13). */
  envelopes: { v1: number; v2: number };
}

export interface SecretKeyStatusResponse {
  keyStatus: SecretKeyStatus;
}

// ---------------------------------------------------------------------------
// Break-glass reveal (saas-secret-manager SEC7)
// ---------------------------------------------------------------------------
// The reveal route is the ONE human-facing response that returns a secret
// VALUE. It is elevated + audited (a non-empty `reason` is mandatory) — see
// apps/config-worker/src/handlers/reveal-secret.ts. The value materializes only
// transiently in the caller (the console's break-glass dialog); it is never
// cached, logged, or persisted.

export interface RevealSecretRequest {
  /** Mandatory, non-empty justification. Recorded to the audit row — never the value. */
  reason: string;
}

export interface RevealSecretResponse {
  secret: {
    /** The decrypted plaintext. Transient — show once, never store. */
    value: string;
    version: number;
  };
}

// ---------------------------------------------------------------------------
// Materialization provenance (saas-secret-manager SM5)
// ---------------------------------------------------------------------------
// Mirrors apps/config-worker/src/mappers.ts `toPublicSecretSync`. References +
// lifecycle only — a secret VALUE never appears.

export interface PublicSecretSync {
  id: string;
  secretId: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  version: number;
  /** The adapter the value was materialized onto (e.g. a provider store). */
  target: string;
  /** The provisioned catalog entity the value was written into. */
  entityRef: string;
  runId: string;
  /** Lifecycle: `synced` (current) -> `superseded` -> `orphaned`. */
  status: string;
  syncedAt: string;
}

export interface ListSecretSyncsResponse {
  syncs: PublicSecretSync[];
}

// ---------------------------------------------------------------------------
// Secret policies (saas-secret-manager SM3, Layer 2)
// ---------------------------------------------------------------------------
// Tier-tagged, portable SecretPolicy documents — the who/what/where/how
// conditions the resolve evaluates. NEVER any secret value. Backed by
// apps/config-worker/src/handlers/{list,put,evaluate}-secret-policy.ts.

export type SecretPolicyTier = "composition" | "stack" | "intent";

/** Tenancy scope a policy document lives at. Workspace-wide documents always
 *  join a project's evaluation; there is no environment-scoped policy. */
export type SecretPolicyScopeKind = "organization" | "project";

/** A stored SecretPolicy document as surfaced by the read/list surface. The
 *  `document` is the validated `{ rules: [...] }` spec; its tenancy scope comes
 *  from the route, not the body. */
export interface PublicSecretPolicy {
  name: string;
  tier: SecretPolicyTier;
  source: string;
  scope: SecretPolicyScopeKind;
  documentHash: string;
  document: Record<string, unknown>;
  createdAt: string;
}

export interface ListSecretPoliciesResponse {
  policies: PublicSecretPolicy[];
}

/** Push (PUT) a tier-tagged document. Idempotent by document hash. */
export interface PutSecretPolicyRequest {
  name: string;
  tier: SecretPolicyTier;
  source: string;
  document: Record<string, unknown>;
}

export interface PutSecretPolicyResponse {
  policy: {
    name: string;
    tier: SecretPolicyTier;
    source: string;
    scope: SecretPolicyScopeKind;
    documentHash: string;
    /** `false` when the pushed document was byte-identical to the stored one. */
    updated: boolean;
  };
}

// ── Policy evaluation (dry-run — the console face of `orun policy test`) ──
// The request body is FLAT (matches evaluate-secret-policy.ts): the facts sit
// alongside `key`, not nested under a `facts` envelope.

export type SecretPolicyPlatform = "local-cli" | "ci-oidc" | "service";
export type SecretPolicySubjectKind = "user" | "service_principal" | "workflow";
export type SecretPolicyServesFrom = "environment" | "project" | "workspace" | "account";

export interface EvaluateSecretPolicySubject {
  id?: string;
  kind?: SecretPolicySubjectKind;
  teams?: string[];
}

export interface EvaluateSecretPolicyComponent {
  type?: string;
  domain?: string;
  name?: string;
  labels?: Record<string, string>;
}

export interface EvaluateSecretPolicyTrigger {
  event?: string;
  action?: string;
  branch?: string;
  baseBranch?: string;
  tag?: string;
  declared?: boolean;
  actor?: string;
  repository?: string;
}

export interface EvaluateSecretPolicyRequest {
  key: string;
  env: string;
  platform: SecretPolicyPlatform;
  subject?: EvaluateSecretPolicySubject;
  servesFrom?: SecretPolicyServesFrom;
  component?: EvaluateSecretPolicyComponent;
  trigger?: EvaluateSecretPolicyTrigger;
}

/** One layer's decision. `ruleId` is present when a concrete rule decided it. */
export interface SecretPolicyLayerDecision {
  allow: boolean;
  ruleId?: string;
  reason: string;
}

export interface EvaluateSecretPolicyResponse {
  /** Layer-1 role×scope RBAC probe of the resolve action (`secret.value.use`). */
  layer1: { action: string; allow: boolean; reason: string };
  /** Layer-2 SecretPolicy condition decision. */
  layer2: SecretPolicyLayerDecision;
  /** The combined outcome (`layer1.allow && layer2.allow`). */
  decision: { allow: boolean };
}
