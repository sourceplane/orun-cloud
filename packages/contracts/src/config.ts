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

export interface CreateSecretMetadataResponse {
  secret: PublicSecretMetadata;
}

/** Write-only secret rotation with a replacement value. */
export interface RotateSecretRequest {
  /** Write-only replacement secret value. Encrypted before persistence; never returned. */
  value: string;
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
