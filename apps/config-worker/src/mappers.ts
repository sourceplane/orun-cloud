import type { Setting, FeatureFlag, SecretMetadata, SecretVersion, SecretSync } from "@saas/db/config";
import type { PublicSetting, PublicFeatureFlag, PublicSecretMetadata, PublicSecretVersion } from "@saas/contracts/config";
import type { ResolutionSource, SecretServesFrom } from "./config-resolver.js";
import {
  orgPublicId,
  settingPublicId,
  featureFlagPublicId,
  secretMetadataPublicId,
  secretSyncPublicId,
} from "./ids.js";

function projectPublicId(uuid: string): string {
  return `prj_${uuid.replace(/-/g, "")}`;
}

function environmentPublicId(uuid: string): string {
  return `env_${uuid.replace(/-/g, "")}`;
}

function toISOString(d: Date): string {
  return d.toISOString();
}

function mapScopeIds(row: { orgId: string; projectId: string | null; environmentId: string | null }) {
  return {
    orgId: orgPublicId(row.orgId),
    projectId: row.projectId ? projectPublicId(row.projectId) : null,
    environmentId: row.environmentId ? environmentPublicId(row.environmentId) : null,
  };
}

export function toPublicSetting(s: Setting): PublicSetting {
  return {
    id: settingPublicId(s.id),
    ...mapScopeIds(s),
    scopeKind: s.scopeKind,
    key: s.key,
    value: s.value,
    description: s.description,
    overridable: s.overridable,
    createdAt: toISOString(s.createdAt),
    updatedAt: toISOString(s.updatedAt),
  };
}

/**
 * Map a resolved setting (scope-resolution chain, WID7) onto the public shape.
 * Carries provenance (`inheritedFrom.scopeKind` = the rung the value was found at,
 * or `default`) and the `overridable` flag of the winning value. When the value
 * came from an actual row, the row's public fields are surfaced; for the `default`
 * source there is no row, so only key/value/provenance are populated.
 */
export function toResolvedPublicSetting(resolved: {
  source: ResolutionSource;
  value: unknown;
  overridable: boolean;
  setting: Setting | null;
}, key: string): PublicSetting {
  const { setting, source, value, overridable } = resolved;
  if (setting) {
    return {
      ...toPublicSetting(setting),
      overridable,
      inheritedFrom: { scopeKind: source },
    };
  }
  // `default` source — no backing row.
  return {
    id: "",
    orgId: "",
    projectId: null,
    environmentId: null,
    scopeKind: source,
    key,
    value,
    description: null,
    overridable,
    inheritedFrom: { scopeKind: source },
    createdAt: "",
    updatedAt: "",
  };
}

export function toPublicFeatureFlag(f: FeatureFlag): PublicFeatureFlag {
  return {
    id: featureFlagPublicId(f.id),
    ...mapScopeIds(f),
    scopeKind: f.scopeKind,
    flagKey: f.flagKey,
    enabled: f.enabled,
    value: f.value,
    description: f.description,
    createdAt: toISOString(f.createdAt),
    updatedAt: toISOString(f.updatedAt),
  };
}

export function toPublicSecretMetadata(s: SecretMetadata): PublicSecretMetadata {
  // personal_owner never crosses the boundary as a raw uuid — only the fact
  // that the row is a personal overlay (visibility is owner-filtered upstream).
  return {
    id: secretMetadataPublicId(s.id),
    ...mapScopeIds(s),
    scopeKind: s.scopeKind,
    secretKey: s.secretKey,
    displayName: s.displayName,
    status: s.status,
    version: s.version,
    rotationPolicy: s.rotationPolicy,
    lastRotatedAt: s.lastRotatedAt ? toISOString(s.lastRotatedAt) : null,
    expiresAt: s.expiresAt ? toISOString(s.expiresAt) : null,
    createdBy: s.createdBy,
    overridable: s.overridable,
    personal: s.personalOwner !== null,
    lastUsedAt: s.lastUsedAt ? toISOString(s.lastUsedAt) : null,
    createdAt: toISOString(s.createdAt),
    updatedAt: toISOString(s.updatedAt),
  };
}

/**
 * Map a chain-serving secret head (saas-secret-manager SM1) onto the public
 * shape with its provenance rung. Metadata only — never ciphertext.
 */
export function toChainPublicSecretMetadata(s: SecretMetadata, servesFrom: SecretServesFrom): PublicSecretMetadata {
  return {
    ...toPublicSecretMetadata(s),
    servesFrom,
  };
}

export function toPublicSecretVersion(v: SecretVersion): PublicSecretVersion {
  return {
    secretId: secretMetadataPublicId(v.secretId),
    version: v.version,
    status: v.status,
    createdBy: v.createdBy,
    createdAt: toISOString(v.createdAt),
  };
}

/**
 * Public shape of a materialization-provenance row (saas-secret-manager SM5).
 * Metadata only — references + lifecycle, never a secret value.
 */
export interface PublicSecretSync {
  id: string;
  secretId: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  version: number;
  target: string;
  entityRef: string;
  runId: string;
  status: string;
  syncedAt: string;
}

export function toPublicSecretSync(s: SecretSync): PublicSecretSync {
  return {
    id: secretSyncPublicId(s.id),
    secretId: secretMetadataPublicId(s.secretId),
    ...mapScopeIds(s),
    version: s.version,
    target: s.target,
    entityRef: s.entityRef,
    runId: s.runId,
    status: s.status,
    syncedAt: toISOString(s.syncedAt),
  };
}
