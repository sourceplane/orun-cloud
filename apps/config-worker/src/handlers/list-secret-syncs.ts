import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, Scope, ListSecretSyncsFilter, SecretSyncStatus } from "@saas/db/config";
import { createConfigRepository } from "@saas/db/config";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, listResponse, validationError } from "../http.js";
import { toPublicSecretSync } from "../mappers.js";
import { parsePageParams, encodeCursor } from "../pagination.js";
import type { PolicyResource } from "@saas/contracts/policy";

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;
const SYNC_STATUSES: SecretSyncStatus[] = ["synced", "superseded", "orphaned"];

export interface ListSecretSyncsDeps {
  repo: Pick<ConfigRepository, "listSecretSyncs" | "getSecretMetadataByScopeKey">;
}

/**
 * GET …/config/secrets/syncs (saas-secret-manager SM5). Paged, metadata-only
 * provenance listing backing the catalog facet's per-entity (`entityRef`) and
 * per-component (`secretKey`) views, filterable by lifecycle `status`.
 * `secret.read`.
 */
export async function handleListSecretSyncs(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  requestedScope: Scope,
  deps?: ListSecretSyncsDeps,
): Promise<Response> {
  const orgId = requestedScope.orgId;
  const url = new URL(request.url);

  const pageResult = parsePageParams(url);
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }
  const { limit, cursor } = pageResult.value;
  const dbCursor = cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null;

  const entityRefParam = url.searchParams.get("entityRef");
  const statusParam = url.searchParams.get("status");
  const secretKeyParam = url.searchParams.get("secretKey");

  const fields: Record<string, string[]> = {};
  if (statusParam !== null && !SYNC_STATUSES.includes(statusParam as SecretSyncStatus)) {
    fields.status = ["status must be one of: synced, superseded, orphaned"];
  }
  if (entityRefParam !== null && (entityRefParam.length === 0 || entityRefParam.length > 512)) {
    fields.entityRef = ["entityRef must be 1-512 chars"];
  }
  if (secretKeyParam !== null && !KEY_RE.test(secretKeyParam)) {
    fields.secretKey = ["secretKey must be a valid key (letters, digits, dots, hyphens, underscores; 1-128 chars)"];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.MEMBERSHIP_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  // Authorization (read).
  if (!deps) {
    const contextResult = await fetchAuthorizationContext(
      env.MEMBERSHIP_WORKER!,
      actor.subjectId,
      actor.subjectType,
      orgId,
      requestId,
    );
    if (!contextResult.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    const resource: PolicyResource = { kind: requestedScope.kind === "organization" ? "organization" : "project", orgId };
    if ("projectId" in requestedScope) {
      resource.projectId = requestedScope.projectId;
    }
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

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);

    const filter: ListSecretSyncsFilter = {};
    if (entityRefParam !== null) filter.entityRef = entityRefParam;
    if (statusParam !== null) filter.status = statusParam as SecretSyncStatus;
    if (secretKeyParam !== null) {
      // Per-component view: translate the key to its secret_id in scope. An
      // unknown key matches nothing (empty list) rather than 404-ing the facet.
      const secret = await repo.getSecretMetadataByScopeKey(requestedScope, secretKeyParam);
      if (!secret.ok) {
        return listResponse({ syncs: [] }, requestId, null);
      }
      filter.secretId = secret.value.id;
    }

    const result = await repo.listSecretSyncs(requestedScope, filter, { limit, cursor: dbCursor });
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const syncs = result.value.items.map(toPublicSecretSync);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return listResponse({ syncs }, requestId, nextCursor);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
