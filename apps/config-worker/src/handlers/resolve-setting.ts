import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, Scope } from "@saas/db/config";
import type { MembershipRepository } from "@saas/db/membership";
import { createConfigRepository } from "@saas/db/config";
import { createMembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { toResolvedPublicSetting } from "../mappers.js";
import { resolveSetting } from "../config-resolver.js";
import type { PolicyResource } from "@saas/contracts/policy";

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;

export interface ResolveSettingDeps {
  repo: Pick<ConfigRepository, "getSettingByScopeKey">;
  membershipRepo: Pick<MembershipRepository, "getOrganizationById">;
}

/**
 * Resolved read of a single setting (saas-workspace-id WID7). Unlike the
 * exact-scope `listSettings` (management view), this walks the scope-resolution
 * chain (environment -> project -> workspace -> account -> default) so a workspace
 * inherits account-level values. Provenance (`inheritedFrom`) + `overridable` are
 * returned so callers can tell where the value came from and whether it is locked.
 *
 * The `key` is taken from the `?key=` query param.
 */
export async function handleResolveSetting(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: ResolveSettingDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key || !KEY_RE.test(key)) {
    return validationError(requestId, { key: ["A valid setting key is required via the ?key= query parameter"] });
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.MEMBERSHIP_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  if (deps) {
    const resolved = await resolveSetting(deps.repo, deps.membershipRepo, scope, key);
    return successResponse({ setting: toResolvedPublicSetting(resolved, key) }, requestId);
  }

  // Authorization (read).
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    scope.orgId,
    requestId,
  );
  if (!contextResult.ok) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const policyAction = scope.kind === "organization" ? "organization.config.read" : "project.config.read";
  const resource: PolicyResource = { kind: scope.kind === "organization" ? "organization" : "project", orgId: scope.orgId };
  if ("projectId" in scope) {
    resource.projectId = scope.projectId;
  }

  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    policyAction,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createConfigRepository(executor);
    const membershipRepo = createMembershipRepository(executor);
    const resolved = await resolveSetting(repo, membershipRepo, scope, key);
    return successResponse({ setting: toResolvedPublicSetting(resolved, key) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
