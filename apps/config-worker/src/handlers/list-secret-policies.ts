import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Scope } from "@saas/db/config";
import type { ConfigRepository } from "@saas/db/config";
import { createConfigRepository } from "@saas/db/config";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse } from "../http.js";
import { toPublicSecretPolicy } from "../mappers.js";
import type { PolicyResource } from "@saas/contracts/policy";

export interface ListSecretPoliciesDeps {
  repo: Pick<ConfigRepository, "listSecretPolicies">;
}

/**
 * GET …/config/secret-policies (saas-secret-manager SM3). Lists the tier-ordered
 * SecretPolicy documents (composition → stack → intent) in scope — the read side
 * of the Layer-2 push. At project scope the workspace-wide documents join the
 * project's own. Layer-1 `secret.read`. Metadata only — never a secret value.
 */
export async function handleListSecretPolicies(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: ListSecretPoliciesDeps,
): Promise<Response> {
  if (!deps && (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER)) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  // Authorization (read).
  if (!deps) {
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
    const resource: PolicyResource = { kind: scope.kind === "organization" ? "organization" : "project", orgId: scope.orgId };
    if ("projectId" in scope) resource.projectId = scope.projectId;
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
    const listed = await repo.listSecretPolicies({
      orgId: scope.orgId,
      projectId: "projectId" in scope ? scope.projectId : null,
    });
    if (!listed.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    return successResponse({ policies: listed.value.map(toPublicSecretPolicy) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
