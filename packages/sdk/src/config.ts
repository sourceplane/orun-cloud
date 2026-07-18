import type {
  CreateBrokeredSecretRequest,
  CreateFeatureFlagRequest,
  CreateFeatureFlagResponse,
  CreateSecretMetadataResponse,
  CreateSecretRequest,
  CreateSettingRequest,
  CreateSettingResponse,
  EvaluateSecretPolicyRequest,
  EvaluateSecretPolicyResponse,
  ListFeatureFlagsResponse,
  ListSecretMetadataResponse,
  ListSecretPoliciesResponse,
  ListSecretSyncsResponse,
  ListSecretVersionsResponse,
  ListSettingsResponse,
  PutSecretPolicyRequest,
  PutSecretPolicyResponse,
  RepointBrokeredSecretRequest,
  RevealSecretRequest,
  RevealSecretResponse,
  RevokeSecretMetadataResponse,
  RotateSecretMetadataResponse,
  RotateSecretRequest,
  RotateScopedCredentialRequest,
  UpdateFeatureFlagRequest,
  UpdateFeatureFlagResponse,
  UpdateSettingRequest,
  UpdateSettingResponse,
} from "@saas/contracts/config";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Config (settings / feature-flags / secrets-metadata) resource client.
 *
 * Backed by `apps/config-worker` via the api-edge `config-facade`. The facade
 * exposes the same three resource families at three scopes — organization,
 * project, and environment — each surfaced here as a single flat method that
 * takes a discriminated `scope` argument so call sites stay grep-able and the
 * SDK doesn't fan out into a nine-permutation method tree.
 *
 * Secret values are write-only: `createSecretMetadata` and `rotateSecret`
 * accept a `value` field that the worker encrypts before persistence and that
 * NEVER appears in any response. List responses carry metadata only.
 */

/** Discriminated scope identifying which surface the call targets. */
export type ConfigScope =
  | { kind: "organization"; orgId: string }
  | { kind: "project"; orgId: string; projectId: string }
  | {
      kind: "environment";
      orgId: string;
      projectId: string;
      environmentId: string;
    };

export class ConfigClient {
  constructor(private readonly transport: Transport) {}

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /** GET <scope>/config/settings */
  listSettings(
    scope: ConfigScope,
    opts: RequestOptions = {},
  ): Promise<ListSettingsResponse> {
    return this.transport.request<ListSettingsResponse>(
      { method: "GET", path: `${scopeBase(scope)}/settings` },
      opts,
    );
  }

  /** POST <scope>/config/settings */
  createSetting(
    scope: ConfigScope,
    body: CreateSettingRequest,
    opts: RequestOptions = {},
  ): Promise<CreateSettingResponse> {
    return this.transport.request<CreateSettingResponse>(
      { method: "POST", path: `${scopeBase(scope)}/settings`, body },
      opts,
    );
  }

  /** PATCH <scope>/config/settings/:settingId — addressed by public id (`set_…`), not key. */
  updateSetting(
    scope: ConfigScope,
    settingId: string,
    body: UpdateSettingRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateSettingResponse> {
    return this.transport.request<UpdateSettingResponse>(
      {
        method: "PATCH",
        path: `${scopeBase(scope)}/settings/${encodeURIComponent(settingId)}`,
        body,
      },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------

  /** GET <scope>/config/feature-flags */
  listFeatureFlags(
    scope: ConfigScope,
    opts: RequestOptions = {},
  ): Promise<ListFeatureFlagsResponse> {
    return this.transport.request<ListFeatureFlagsResponse>(
      { method: "GET", path: `${scopeBase(scope)}/feature-flags` },
      opts,
    );
  }

  /** POST <scope>/config/feature-flags */
  createFeatureFlag(
    scope: ConfigScope,
    body: CreateFeatureFlagRequest,
    opts: RequestOptions = {},
  ): Promise<CreateFeatureFlagResponse> {
    return this.transport.request<CreateFeatureFlagResponse>(
      { method: "POST", path: `${scopeBase(scope)}/feature-flags`, body },
      opts,
    );
  }

  /** PATCH <scope>/config/feature-flags/:flagId — addressed by public id (`flg_…`), not key. */
  updateFeatureFlag(
    scope: ConfigScope,
    flagId: string,
    body: UpdateFeatureFlagRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateFeatureFlagResponse> {
    return this.transport.request<UpdateFeatureFlagResponse>(
      {
        method: "PATCH",
        path: `${scopeBase(scope)}/feature-flags/${encodeURIComponent(flagId)}`,
        body,
      },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Secrets (metadata-only reads; write-only `value` on create/rotate)
  // -------------------------------------------------------------------------

  /** GET <scope>/config/secrets */
  listSecretMetadata(
    scope: ConfigScope,
    opts: RequestOptions = {},
  ): Promise<ListSecretMetadataResponse> {
    return this.transport.request<ListSecretMetadataResponse>(
      { method: "GET", path: `${scopeBase(scope)}/secrets` },
      opts,
    );
  }

  /**
   * POST <scope>/config/secrets
   *
   * The `value` field is write-only — the api-edge worker encrypts it before
   * persistence and the response carries metadata only.
   */
  createSecretMetadata(
    scope: ConfigScope,
    body: CreateSecretRequest,
    opts: RequestOptions = {},
  ): Promise<CreateSecretMetadataResponse> {
    return this.transport.request<CreateSecretMetadataResponse>(
      { method: "POST", path: `${scopeBase(scope)}/secrets`, body },
      opts,
    );
  }

  /**
   * POST <scope>/config/secrets — brokered creation (saas-integration-hub IH7).
   *
   * The `binding` names a credential-broker connection + scope template in
   * place of a `value`: nothing is stored; the value is minted just-in-time at
   * resolve. Requires both `secret.write` and the broker's
   * `organization.integration.credential.issue`. Mutually exclusive with
   * `value` and `personal`.
   */
  createBrokeredSecret(
    scope: ConfigScope,
    body: CreateBrokeredSecretRequest,
    opts: RequestOptions = {},
  ): Promise<CreateSecretMetadataResponse> {
    return this.transport.request<CreateSecretMetadataResponse>(
      { method: "POST", path: `${scopeBase(scope)}/secrets`, body },
      opts,
    );
  }

  /**
   * POST <scope>/config/secrets/:secretId/rotate — addressed by public id (`sec_…`), not key.
   *
   * Rotates a secret's value. Write-only — the rotated value is never echoed
   * back in any response, event, or audit payload.
   */
  rotateSecret(
    scope: ConfigScope,
    secretId: string,
    body: RotateSecretRequest,
    opts: RequestOptions = {},
  ): Promise<RotateSecretMetadataResponse> {
    return this.transport.request<RotateSecretMetadataResponse>(
      {
        method: "POST",
        path: `${scopeBase(scope)}/secrets/${encodeURIComponent(secretId)}/rotate`,
        body,
      },
      opts,
    );
  }

  /**
   * POST <scope>/config/secrets/:secretId/rotate — rotate a SCOPED credential
   * (brokered secret, SC2). No value: rolls the connection's org-owned source
   * credential and stamps lastRotatedAt; `rotationPolicy` sets the cadence,
   * `rotate:false` edits the cadence only. Same route as the static rotate;
   * the server dispatches by the secret's source.
   */
  rotateScopedCredential(
    scope: ConfigScope,
    secretId: string,
    body: RotateScopedCredentialRequest = {},
    opts: RequestOptions = {},
  ): Promise<RotateSecretMetadataResponse> {
    return this.transport.request<RotateSecretMetadataResponse>(
      {
        method: "POST",
        path: `${scopeBase(scope)}/secrets/${encodeURIComponent(secretId)}/rotate`,
        body,
      },
      opts,
    );
  }

  /** DELETE <scope>/config/secrets/:secretId — soft-delete (revoke); addressed by public id (`sec_…`). */
  revokeSecret(
    scope: ConfigScope,
    secretId: string,
    opts: RequestOptions = {},
  ): Promise<RevokeSecretMetadataResponse> {
    return this.transport.request<RevokeSecretMetadataResponse>(
      {
        method: "DELETE",
        path: `${scopeBase(scope)}/secrets/${encodeURIComponent(secretId)}`,
      },
      opts,
    );
  }

  /**
   * PATCH <scope>/config/secrets/:secretId — repoint a brokered secret's
   * binding to a different connection (brokered-orphan-safety, Feature 7): the
   * recovery path for an orphaned head. Requires both `secret.write` and the
   * broker's `organization.integration.credential.issue`; the new connection is
   * re-validated before the pointer moves. No value is ever touched.
   */
  repointBrokeredSecret(
    scope: ConfigScope,
    secretId: string,
    body: RepointBrokeredSecretRequest,
    opts: RequestOptions = {},
  ): Promise<CreateSecretMetadataResponse> {
    return this.transport.request<CreateSecretMetadataResponse>(
      {
        method: "PATCH",
        path: `${scopeBase(scope)}/secrets/${encodeURIComponent(secretId)}`,
        body,
      },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Secret chain / history / provenance / reveal (SM1 / SM5 / SEC7)
  // -------------------------------------------------------------------------

  /**
   * GET <environment-scope>/config/secrets?chain=true — the chain read
   * (saas-secret-manager SM1). Walks the scope-resolution chain (personal ->
   * environment -> project -> workspace -> account) and returns each key's
   * serving head with its `servesFrom` rung + `overridable` flag. Metadata only.
   * Only meaningful at environment scope.
   */
  listSecretChain(
    scope: ConfigScope,
    opts: RequestOptions = {},
  ): Promise<ListSecretMetadataResponse> {
    return this.transport.request<ListSecretMetadataResponse>(
      { method: "GET", path: `${scopeBase(scope)}/secrets`, query: { chain: "true" } },
      opts,
    );
  }

  /** GET <scope>/config/secrets/:secretId/versions — append-only version history (metadata only). */
  listSecretVersions(
    scope: ConfigScope,
    secretId: string,
    opts: RequestOptions = {},
  ): Promise<ListSecretVersionsResponse> {
    return this.transport.request<ListSecretVersionsResponse>(
      {
        method: "GET",
        path: `${scopeBase(scope)}/secrets/${encodeURIComponent(secretId)}/versions`,
      },
      opts,
    );
  }

  /**
   * GET <scope>/config/secrets/syncs — materialization provenance (SM5).
   * Optionally filtered per-entity (`entityRef`), per-component (`secretKey`),
   * or by lifecycle `status`. Metadata only — never a secret value.
   */
  listSecretSyncs(
    scope: ConfigScope,
    filter: SecretSyncFilter = {},
    opts: RequestOptions = {},
  ): Promise<ListSecretSyncsResponse> {
    return this.transport.request<ListSecretSyncsResponse>(
      {
        method: "GET",
        path: `${scopeBase(scope)}/secrets/syncs`,
        query: {
          ...(filter.entityRef !== undefined ? { entityRef: filter.entityRef } : {}),
          ...(filter.secretKey !== undefined ? { secretKey: filter.secretKey } : {}),
          ...(filter.status !== undefined ? { status: filter.status } : {}),
        },
      },
      opts,
    );
  }

  /**
   * POST <scope>/config/secrets/:secretId/reveal — the ONE value-returning route
   * (saas-secret-manager SEC7). Elevated + audited break-glass: a non-empty
   * `reason` is mandatory and every reveal emits an alert-worthy audit row. The
   * returned value is transient — never cache or persist it.
   */
  revealSecret(
    scope: ConfigScope,
    secretId: string,
    body: RevealSecretRequest,
    opts: RequestOptions = {},
  ): Promise<RevealSecretResponse> {
    return this.transport.request<RevealSecretResponse>(
      {
        method: "POST",
        path: `${scopeBase(scope)}/secrets/${encodeURIComponent(secretId)}/reveal`,
        body,
      },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Secret policies (SM3, Layer 2) — org / project scope only
  // -------------------------------------------------------------------------

  /** GET <scope>/config/secret-policies — the tier-ordered documents in scope. */
  listSecretPolicies(
    scope: ConfigScope,
    opts: RequestOptions = {},
  ): Promise<ListSecretPoliciesResponse> {
    return this.transport.request<ListSecretPoliciesResponse>(
      { method: "GET", path: `${scopeBase(scope)}/secret-policies` },
      opts,
    );
  }

  /** PUT <scope>/config/secret-policies — push a tier-tagged document (idempotent by hash). */
  putSecretPolicy(
    scope: ConfigScope,
    body: PutSecretPolicyRequest,
    opts: RequestOptions = {},
  ): Promise<PutSecretPolicyResponse> {
    return this.transport.request<PutSecretPolicyResponse>(
      { method: "PUT", path: `${scopeBase(scope)}/secret-policies`, body },
      opts,
    );
  }

  /**
   * POST <scope>/config/secret-policies/evaluate — the dry-run behind
   * `orun policy test`. Reports BOTH layers (Layer-1 RBAC + Layer-2 SecretPolicy)
   * for a hypothetical resolve without serving any value.
   */
  evaluateSecretPolicy(
    scope: ConfigScope,
    body: EvaluateSecretPolicyRequest,
    opts: RequestOptions = {},
  ): Promise<EvaluateSecretPolicyResponse> {
    return this.transport.request<EvaluateSecretPolicyResponse>(
      { method: "POST", path: `${scopeBase(scope)}/secret-policies/evaluate`, body },
      opts,
    );
  }
}

/** Metadata-only filters for a secret-sync list (SM5). */
export interface SecretSyncFilter {
  entityRef?: string;
  secretKey?: string;
  status?: "synced" | "superseded" | "orphaned";
}

function scopeBase(scope: ConfigScope): string {
  switch (scope.kind) {
    case "organization":
      return `/v1/organizations/${encodeURIComponent(scope.orgId)}/config`;
    case "project":
      return `/v1/organizations/${encodeURIComponent(scope.orgId)}/projects/${encodeURIComponent(scope.projectId)}/config`;
    case "environment":
      return `/v1/organizations/${encodeURIComponent(scope.orgId)}/projects/${encodeURIComponent(scope.projectId)}/environments/${encodeURIComponent(scope.environmentId)}/config`;
  }
}
