import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, Scope } from "@saas/db/config";
import { createConfigRepository } from "@saas/db/config";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, listResponse, validationError } from "../http.js";
import { toPublicSecretVersion } from "../mappers.js";
import { parsePageParams, encodeCursor } from "../pagination.js";
import { scopeMatchesRequested } from "../scope-match.js";
import type { PolicyResource } from "@saas/contracts/policy";

export interface ListSecretVersionsDeps {
  repo: Pick<ConfigRepository, "getSecretMetadata" | "listSecretVersions">;
}

/**
 * Version history of a secret (saas-secret-manager SM1):
 * `GET …/config/secrets/{id}/versions`. Paged, newest first, and metadata only —
 * the ciphertext envelope of a version never crosses any read surface.
 */
export async function handleListSecretVersions(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  requestedScope: Scope,
  secretId: string,
  deps?: ListSecretVersionsDeps,
): Promise<Response> {
  const orgId = requestedScope.orgId;

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

    const existing = await repo.getSecretMetadata(orgId, secretId);
    if (!existing.ok) {
      if (existing.error.kind === "not_found") {
        return errorResponse("not_found", "Secret not found", 404, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    if (!scopeMatchesRequested(existing.value, requestedScope)) {
      return errorResponse("not_found", "Secret not found", 404, requestId);
    }

    const result = await repo.listSecretVersions(orgId, secretId, { limit, cursor: dbCursor });
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const versions = result.value.items.map(toPublicSecretVersion);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return listResponse({ versions }, requestId, nextCursor);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
