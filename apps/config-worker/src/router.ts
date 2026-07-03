import type { Env } from "./env.js";
import type { Scope } from "@saas/db/config";
import { handleHealth } from "./handlers/health.js";
import { handleListSettings } from "./handlers/list-settings.js";
import { handleResolveSetting } from "./handlers/resolve-setting.js";
import { handleListFeatureFlags } from "./handlers/list-feature-flags.js";
import { handleListSecrets } from "./handlers/list-secrets.js";
import { handleCreateSetting } from "./handlers/create-setting.js";
import { handleUpdateSetting } from "./handlers/update-setting.js";
import { handleCreateFeatureFlag } from "./handlers/create-feature-flag.js";
import { handleUpdateFeatureFlag } from "./handlers/update-feature-flag.js";
import { handleCreateSecret } from "./handlers/create-secret.js";
import { handleRotateSecret } from "./handlers/rotate-secret.js";
import { handleRevealSecret } from "./handlers/reveal-secret.js";
import { handleRevokeSecret } from "./handlers/revoke-secret.js";
import { handleImportSecrets } from "./handlers/import-secrets.js";
import { handleSecretKeyStatus } from "./handlers/secret-key-status.js";
import { handleListSecretChain } from "./handlers/list-secret-chain.js";
import { handleListSecretVersions } from "./handlers/list-secret-versions.js";
import { handlePutSecretPolicy } from "./handlers/put-secret-policy.js";
import { handleEvaluateSecretPolicy } from "./handlers/evaluate-secret-policy.js";
import { handleListSecretPolicies } from "./handlers/list-secret-policies.js";
import { handleRecordSecretSync } from "./handlers/record-secret-sync.js";
import { handleListSecretSyncs } from "./handlers/list-secret-syncs.js";
import { handleInternalResolveSecrets } from "./handlers/internal-resolve-secrets.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";
import { generateRequestId, parseOrgPublicId, parseProjectPublicId, parseEnvironmentPublicId, parseSettingPublicId, parseFeatureFlagPublicId, parseSecretMetadataPublicId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

// ── Route patterns ──────────────────────────────────────────
// Organization scope
const ORG_SETTINGS_RE = /^\/v1\/organizations\/([^/]+)\/config\/settings$/;
const ORG_FEATURE_FLAGS_RE = /^\/v1\/organizations\/([^/]+)\/config\/feature-flags$/;
const ORG_SECRETS_RE = /^\/v1\/organizations\/([^/]+)\/config\/secrets$/;

// Project scope
const PRJ_SETTINGS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/settings$/;
const PRJ_FEATURE_FLAGS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/feature-flags$/;
const PRJ_SECRETS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/secrets$/;

// Environment scope
const ENV_SETTINGS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/settings$/;
const ENV_FEATURE_FLAGS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/feature-flags$/;
const ENV_SECRETS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/secrets$/;

// Resolved settings read (WID7): GET .../config/settings/resolve?key=...
// Walks the scope-resolution chain (env -> project -> workspace -> account ->
// default) so a workspace inherits account-level values.
const ORG_SETTINGS_RESOLVE_RE = /^\/v1\/organizations\/([^/]+)\/config\/settings\/resolve$/;
const PRJ_SETTINGS_RESOLVE_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/settings\/resolve$/;
const ENV_SETTINGS_RESOLVE_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/settings\/resolve$/;

// Item-level routes (PATCH for settings/flags)
const ORG_SETTING_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/config\/settings\/([^/]+)$/;
const ORG_FLAG_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/config\/feature-flags\/([^/]+)$/;
const PRJ_SETTING_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/settings\/([^/]+)$/;
const PRJ_FLAG_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/feature-flags\/([^/]+)$/;
const ENV_SETTING_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/settings\/([^/]+)$/;
const ENV_FLAG_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/feature-flags\/([^/]+)$/;

// Item-level secret routes (rotate: POST .../secrets/{id}/rotate, revoke: DELETE .../secrets/{id})
const ORG_SECRET_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/config\/secrets\/([^/]+)$/;
const PRJ_SECRET_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/secrets\/([^/]+)$/;
const ENV_SECRET_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/secrets\/([^/]+)$/;

const ORG_SECRET_ROTATE_RE = /^\/v1\/organizations\/([^/]+)\/config\/secrets\/([^/]+)\/rotate$/;
const PRJ_SECRET_ROTATE_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/secrets\/([^/]+)\/rotate$/;
const ENV_SECRET_ROTATE_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/secrets\/([^/]+)\/rotate$/;

// Break-glass reveal (SEC7): POST .../secrets/{id}/reveal — the ONE audited,
// value-returning route. A fixed sub-path like rotate, matched before {id}.
const ORG_SECRET_REVEAL_RE = /^\/v1\/organizations\/([^/]+)\/config\/secrets\/([^/]+)\/reveal$/;
const PRJ_SECRET_REVEAL_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/secrets\/([^/]+)\/reveal$/;
const ENV_SECRET_REVEAL_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/secrets\/([^/]+)\/reveal$/;

// Version history (SM1): GET .../secrets/{id}/versions — metadata only.
const ORG_SECRET_VERSIONS_RE = /^\/v1\/organizations\/([^/]+)\/config\/secrets\/([^/]+)\/versions$/;
const PRJ_SECRET_VERSIONS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/secrets\/([^/]+)\/versions$/;
const ENV_SECRET_VERSIONS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/secrets\/([^/]+)\/versions$/;

// Key-hierarchy status (SM2): GET .../config/secrets/key-status — org scope only.
const ORG_SECRETS_KEY_STATUS_RE = /^\/v1\/organizations\/([^/]+)\/config\/secrets\/key-status$/;

// SecretPolicy documents (SM3, Layer 2): PUT .../config/secret-policies (push a
// tier-tagged document) and POST .../config/secret-policies/evaluate (dry-run).
const ORG_SECRET_POLICIES_RE = /^\/v1\/organizations\/([^/]+)\/config\/secret-policies$/;
const PRJ_SECRET_POLICIES_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/secret-policies$/;
const ORG_SECRET_POLICIES_EVALUATE_RE = /^\/v1\/organizations\/([^/]+)\/config\/secret-policies\/evaluate$/;
const PRJ_SECRET_POLICIES_EVALUATE_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/secret-policies\/evaluate$/;

// Internal, lease-verified resolve (SM3) — reachable ONLY via the state-worker
// service binding. NOT exposed through api-edge (no /v1/internal/* forwarding),
// and does NOT require a user bearer: it trusts the calling worker.
const INTERNAL_SECRETS_RESOLVE_PATH = "/v1/internal/config/secrets/resolve";

// Materialization provenance (SM5): POST records a sync, GET lists them.
// `syncs` is a fixed sub-path (like `import`), matched before the {id} route.
const ORG_SECRETS_SYNCS_RE = /^\/v1\/organizations\/([^/]+)\/config\/secrets\/syncs$/;
const PRJ_SECRETS_SYNCS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/secrets\/syncs$/;
const ENV_SECRETS_SYNCS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/secrets\/syncs$/;

// Bulk write-only import (SM1): POST .../config/secrets/import.
const ORG_SECRETS_IMPORT_RE = /^\/v1\/organizations\/([^/]+)\/config\/secrets\/import$/;
const PRJ_SECRETS_IMPORT_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/config\/secrets\/import$/;
const ENV_SECRETS_IMPORT_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)\/config\/secrets\/import$/;

type ConfigResource = "settings" | "feature-flags" | "secrets";

interface MatchedRoute {
  scope: Scope;
  resource: ConfigResource;
}

function matchRoute(pathname: string): MatchedRoute | null {
  // Environment scope (most specific first)
  let m = pathname.match(ENV_SETTINGS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    if (!orgId || !projectId || !environmentId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId }, resource: "settings" };
  }

  m = pathname.match(ENV_FEATURE_FLAGS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    if (!orgId || !projectId || !environmentId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId }, resource: "feature-flags" };
  }

  m = pathname.match(ENV_SECRETS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    if (!orgId || !projectId || !environmentId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId }, resource: "secrets" };
  }

  // Project scope
  m = pathname.match(PRJ_SETTINGS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return null;
    return { scope: { kind: "project", orgId, projectId }, resource: "settings" };
  }

  m = pathname.match(PRJ_FEATURE_FLAGS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return null;
    return { scope: { kind: "project", orgId, projectId }, resource: "feature-flags" };
  }

  m = pathname.match(PRJ_SECRETS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return null;
    return { scope: { kind: "project", orgId, projectId }, resource: "secrets" };
  }

  // Organization scope
  m = pathname.match(ORG_SETTINGS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { scope: { kind: "organization", orgId }, resource: "settings" };
  }

  m = pathname.match(ORG_FEATURE_FLAGS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { scope: { kind: "organization", orgId }, resource: "feature-flags" };
  }

  m = pathname.match(ORG_SECRETS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { scope: { kind: "organization", orgId }, resource: "secrets" };
  }

  return null;
}

function matchResolveRoute(pathname: string): { scope: Scope } | null {
  let m = pathname.match(ENV_SETTINGS_RESOLVE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    if (!orgId || !projectId || !environmentId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId } };
  }
  m = pathname.match(PRJ_SETTINGS_RESOLVE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return null;
    return { scope: { kind: "project", orgId, projectId } };
  }
  m = pathname.match(ORG_SETTINGS_RESOLVE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { scope: { kind: "organization", orgId } };
  }
  return null;
}

interface MatchedItemRoute {
  scope: Scope;
  itemId: string;
  resource: "settings" | "feature-flags";
}

function matchItemRoute(pathname: string): MatchedItemRoute | null {
  // Environment item scope
  let m = pathname.match(ENV_SETTING_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    const itemId = parseSettingPublicId(m[4]!);
    if (!orgId || !projectId || !environmentId || !itemId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId }, itemId, resource: "settings" };
  }

  m = pathname.match(ENV_FLAG_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    const itemId = parseFeatureFlagPublicId(m[4]!);
    if (!orgId || !projectId || !environmentId || !itemId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId }, itemId, resource: "feature-flags" };
  }

  // Project item scope
  m = pathname.match(PRJ_SETTING_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const itemId = parseSettingPublicId(m[3]!);
    if (!orgId || !projectId || !itemId) return null;
    return { scope: { kind: "project", orgId, projectId }, itemId, resource: "settings" };
  }

  m = pathname.match(PRJ_FLAG_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const itemId = parseFeatureFlagPublicId(m[3]!);
    if (!orgId || !projectId || !itemId) return null;
    return { scope: { kind: "project", orgId, projectId }, itemId, resource: "feature-flags" };
  }

  // Org item scope
  m = pathname.match(ORG_SETTING_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const itemId = parseSettingPublicId(m[2]!);
    if (!orgId || !itemId) return null;
    return { scope: { kind: "organization", orgId }, itemId, resource: "settings" };
  }

  m = pathname.match(ORG_FLAG_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const itemId = parseFeatureFlagPublicId(m[2]!);
    if (!orgId || !itemId) return null;
    return { scope: { kind: "organization", orgId }, itemId, resource: "feature-flags" };
  }

  return null;
}

function matchSecretsImportRoute(pathname: string): { scope: Scope } | null {
  let m = pathname.match(ENV_SECRETS_IMPORT_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    if (!orgId || !projectId || !environmentId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId } };
  }
  m = pathname.match(PRJ_SECRETS_IMPORT_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return null;
    return { scope: { kind: "project", orgId, projectId } };
  }
  m = pathname.match(ORG_SECRETS_IMPORT_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { scope: { kind: "organization", orgId } };
  }
  return null;
}

function matchSecretsSyncsRoute(pathname: string): { scope: Scope } | null {
  let m = pathname.match(ENV_SECRETS_SYNCS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    if (!orgId || !projectId || !environmentId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId } };
  }
  m = pathname.match(PRJ_SECRETS_SYNCS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return null;
    return { scope: { kind: "project", orgId, projectId } };
  }
  m = pathname.match(ORG_SECRETS_SYNCS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { scope: { kind: "organization", orgId } };
  }
  return null;
}

function matchSecretPoliciesRoute(pathname: string): { scope: Scope; action: "put" | "evaluate" } | null {
  let m = pathname.match(PRJ_SECRET_POLICIES_EVALUATE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return null;
    return { scope: { kind: "project", orgId, projectId }, action: "evaluate" };
  }
  m = pathname.match(ORG_SECRET_POLICIES_EVALUATE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { scope: { kind: "organization", orgId }, action: "evaluate" };
  }
  m = pathname.match(PRJ_SECRET_POLICIES_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return null;
    return { scope: { kind: "project", orgId, projectId }, action: "put" };
  }
  m = pathname.match(ORG_SECRET_POLICIES_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { scope: { kind: "organization", orgId }, action: "put" };
  }
  return null;
}

function matchSecretsKeyStatusRoute(pathname: string): { scope: Scope & { kind: "organization" } } | null {
  const m = pathname.match(ORG_SECRETS_KEY_STATUS_RE);
  if (!m) return null;
  const orgId = parseOrgPublicId(m[1]!);
  if (!orgId) return null;
  return { scope: { kind: "organization", orgId } };
}

interface MatchedSecretItemRoute {
  scope: Scope;
  secretId: string;
  action: "rotate" | "revoke" | "versions" | "reveal";
}

function matchSecretItemRoute(pathname: string): MatchedSecretItemRoute | null {
  // Version-history routes (GET .../secrets/{id}/versions)
  let m = pathname.match(ENV_SECRET_VERSIONS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    const secretId = parseSecretMetadataPublicId(m[4]!);
    if (!orgId || !projectId || !environmentId || !secretId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId }, secretId, action: "versions" };
  }

  m = pathname.match(PRJ_SECRET_VERSIONS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const secretId = parseSecretMetadataPublicId(m[3]!);
    if (!orgId || !projectId || !secretId) return null;
    return { scope: { kind: "project", orgId, projectId }, secretId, action: "versions" };
  }

  m = pathname.match(ORG_SECRET_VERSIONS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const secretId = parseSecretMetadataPublicId(m[2]!);
    if (!orgId || !secretId) return null;
    return { scope: { kind: "organization", orgId }, secretId, action: "versions" };
  }

  // Rotate routes (POST .../secrets/{id}/rotate)
  m = pathname.match(ENV_SECRET_ROTATE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    const secretId = parseSecretMetadataPublicId(m[4]!);
    if (!orgId || !projectId || !environmentId || !secretId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId }, secretId, action: "rotate" };
  }

  m = pathname.match(PRJ_SECRET_ROTATE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const secretId = parseSecretMetadataPublicId(m[3]!);
    if (!orgId || !projectId || !secretId) return null;
    return { scope: { kind: "project", orgId, projectId }, secretId, action: "rotate" };
  }

  m = pathname.match(ORG_SECRET_ROTATE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const secretId = parseSecretMetadataPublicId(m[2]!);
    if (!orgId || !secretId) return null;
    return { scope: { kind: "organization", orgId }, secretId, action: "rotate" };
  }

  // Break-glass reveal routes (POST .../secrets/{id}/reveal)
  m = pathname.match(ENV_SECRET_REVEAL_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    const secretId = parseSecretMetadataPublicId(m[4]!);
    if (!orgId || !projectId || !environmentId || !secretId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId }, secretId, action: "reveal" };
  }

  m = pathname.match(PRJ_SECRET_REVEAL_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const secretId = parseSecretMetadataPublicId(m[3]!);
    if (!orgId || !projectId || !secretId) return null;
    return { scope: { kind: "project", orgId, projectId }, secretId, action: "reveal" };
  }

  m = pathname.match(ORG_SECRET_REVEAL_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const secretId = parseSecretMetadataPublicId(m[2]!);
    if (!orgId || !secretId) return null;
    return { scope: { kind: "organization", orgId }, secretId, action: "reveal" };
  }

  // Revoke routes (DELETE .../secrets/{id})
  m = pathname.match(ENV_SECRET_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const environmentId = parseEnvironmentPublicId(m[3]!);
    const secretId = parseSecretMetadataPublicId(m[4]!);
    if (!orgId || !projectId || !environmentId || !secretId) return null;
    return { scope: { kind: "environment", orgId, projectId, environmentId }, secretId, action: "revoke" };
  }

  m = pathname.match(PRJ_SECRET_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const secretId = parseSecretMetadataPublicId(m[3]!);
    if (!orgId || !projectId || !secretId) return null;
    return { scope: { kind: "project", orgId, projectId }, secretId, action: "revoke" };
  }

  m = pathname.match(ORG_SECRET_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const secretId = parseSecretMetadataPublicId(m[2]!);
    if (!orgId || !secretId) return null;
    return { scope: { kind: "organization", orgId }, secretId, action: "revoke" };
  }

  return null;
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    // Internal, lease-verified resolve (SM3). Handled BEFORE the actor gate: it
    // trusts the calling worker (state-worker, which already ran bearer authz +
    // lease verification) and carries no user bearer — exactly like the other
    // /v1/internal/* endpoints. api-edge never forwards this path, so the only
    // reachable caller is the service binding.
    if (url.pathname === INTERNAL_SECRETS_RESOLVE_PATH) {
      if (request.method !== "POST") {
        return methodNotAllowed(requestId);
      }
      // The verified actor rides x-actor-* headers set by the calling worker;
      // no user bearer is required (the caller — state-worker — already ran
      // bearer authz + lease verification).
      const internalActor = resolveActor(request);
      if (!internalActor) {
        return errorResponse("unauthenticated", "Actor headers required", 401, requestId);
      }
      return handleInternalResolveSecrets(request, env, requestId, internalActor);
    }

    const matchedResolve = matchResolveRoute(url.pathname);
    const matched = matchedResolve ? null : matchRoute(url.pathname);
    const matchedItem = (matchedResolve || matched) ? null : matchItemRoute(url.pathname);
    // Import and key-status are matched before the generic secret item route:
    // `import`/`key-status` are reserved path segments, not secret ids.
    const matchedImport = (matchedResolve || matched || matchedItem) ? null : matchSecretsImportRoute(url.pathname);
    // Syncs are matched before the generic secret item route: `syncs` is a
    // reserved sub-path (a fixed collection), not a secret id.
    const matchedSyncs = (matchedResolve || matched || matchedItem || matchedImport) ? null : matchSecretsSyncsRoute(url.pathname);
    // SecretPolicy routes are matched before the generic secret item route:
    // `secret-policies` is a distinct collection, not a secret id.
    const matchedSecretPolicies = (matchedResolve || matched || matchedItem || matchedImport || matchedSyncs) ? null : matchSecretPoliciesRoute(url.pathname);
    const matchedKeyStatus = (matchedResolve || matched || matchedItem || matchedImport || matchedSyncs || matchedSecretPolicies) ? null : matchSecretsKeyStatusRoute(url.pathname);
    const matchedSecretItem = (matchedResolve || matched || matchedItem || matchedImport || matchedSyncs || matchedSecretPolicies || matchedKeyStatus) ? null : matchSecretItemRoute(url.pathname);

    if (!matchedResolve && !matched && !matchedItem && !matchedImport && !matchedSyncs && !matchedSecretPolicies && !matchedKeyStatus && !matchedSecretItem) {
      return notFound(requestId, url.pathname);
    }

    const actor = resolveActor(request);
    if (!actor) {
      return errorResponse("unauthenticated", "Authentication required", 401, requestId);
    }

    // Resolved settings read (WID7): GET only.
    if (matchedResolve) {
      if (request.method !== "GET") {
        return methodNotAllowed(requestId);
      }
      return handleResolveSetting(request, env, requestId, actor, matchedResolve.scope);
    }

    // SecretPolicy routes (SM3): GET list, PUT push, POST evaluate (dry-run).
    if (matchedSecretPolicies) {
      if (matchedSecretPolicies.action === "evaluate") {
        if (request.method !== "POST") {
          return methodNotAllowed(requestId);
        }
        return handleEvaluateSecretPolicy(request, env, requestId, actor, matchedSecretPolicies.scope);
      }
      // The bare collection serves GET (list the tier-ordered documents) and
      // PUT (push a document).
      if (request.method === "GET") {
        return handleListSecretPolicies(request, env, requestId, actor, matchedSecretPolicies.scope);
      }
      if (request.method !== "PUT") {
        return methodNotAllowed(requestId);
      }
      return handlePutSecretPolicy(request, env, requestId, actor, matchedSecretPolicies.scope);
    }

    // Materialization provenance (SM5): POST records a sync, GET lists them.
    if (matchedSyncs) {
      if (request.method === "POST") {
        return handleRecordSecretSync(request, env, requestId, actor, matchedSyncs.scope);
      }
      if (request.method === "GET") {
        return handleListSecretSyncs(request, env, requestId, actor, matchedSyncs.scope);
      }
      return methodNotAllowed(requestId);
    }

    // Bulk write-only secret import (SM1): POST only.
    if (matchedImport) {
      if (request.method !== "POST") {
        return methodNotAllowed(requestId);
      }
      return handleImportSecrets(request, env, requestId, actor, matchedImport.scope);
    }

    // Key-hierarchy status (SM2): GET only.
    if (matchedKeyStatus) {
      if (request.method !== "GET") {
        return methodNotAllowed(requestId);
      }
      return handleSecretKeyStatus(request, env, requestId, actor, matchedKeyStatus.scope);
    }

    // Secret item-level routes (rotate: POST, revoke: DELETE, versions: GET)
    if (matchedSecretItem) {
      if (matchedSecretItem.action === "rotate") {
        if (request.method !== "POST") {
          return methodNotAllowed(requestId);
        }
        return handleRotateSecret(request, env, requestId, actor, matchedSecretItem.scope, matchedSecretItem.secretId);
      }
      if (matchedSecretItem.action === "reveal") {
        if (request.method !== "POST") {
          return methodNotAllowed(requestId);
        }
        return handleRevealSecret(request, env, requestId, actor, matchedSecretItem.scope, matchedSecretItem.secretId);
      }
      if (matchedSecretItem.action === "versions") {
        if (request.method !== "GET") {
          return methodNotAllowed(requestId);
        }
        return handleListSecretVersions(request, env, requestId, actor, matchedSecretItem.scope, matchedSecretItem.secretId);
      }
      if (matchedSecretItem.action === "revoke") {
        if (request.method !== "DELETE") {
          return methodNotAllowed(requestId);
        }
        return handleRevokeSecret(request, env, requestId, actor, matchedSecretItem.scope, matchedSecretItem.secretId);
      }
    }

    // Item-level routes (PATCH only for settings/flags)
    if (matchedItem) {
      if (request.method !== "PATCH") {
        return methodNotAllowed(requestId);
      }
      switch (matchedItem.resource) {
        case "settings":
          return handleUpdateSetting(request, env, requestId, actor, matchedItem.scope, matchedItem.itemId);
        case "feature-flags":
          return handleUpdateFeatureFlag(request, env, requestId, actor, matchedItem.scope, matchedItem.itemId);
      }
    }

    // Collection routes: GET (list) or POST (create)
    if (request.method === "GET") {
      switch (matched!.resource) {
        case "settings":
          return handleListSettings(request, env, requestId, actor, matched!.scope);
        case "feature-flags":
          return handleListFeatureFlags(request, env, requestId, actor, matched!.scope);
        case "secrets":
          // Chain read (SM1): the environment-scope list with ?chain=true walks
          // the whole scope-resolution chain instead of the exact scope.
          if (url.searchParams.get("chain") === "true" && matched!.scope.kind === "environment") {
            return handleListSecretChain(request, env, requestId, actor, matched!.scope as Scope & { kind: "environment" }, undefined);
          }
          return handleListSecrets(request, env, requestId, actor, matched!.scope);
      }
    }

    if (request.method === "POST") {
      switch (matched!.resource) {
        case "settings":
          return handleCreateSetting(request, env, requestId, actor, matched!.scope);
        case "feature-flags":
          return handleCreateFeatureFlag(request, env, requestId, actor, matched!.scope);
        case "secrets":
          return handleCreateSecret(request, env, requestId, actor, matched!.scope);
      }
    }

    return methodNotAllowed(requestId);
  } catch {
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}
