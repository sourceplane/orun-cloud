// Deny-by-default authorization for the run-coordination surface (OP2).
//
// Every state route re-checks policy in the owning worker (the edge only
// authenticates the bearer). This centralizes the two-step gate the run
// handlers share: fetch the actor's role memberships for the org, then ask
// policy-worker for the action on a PROJECT-scoped resource. Cross-tenant
// access is hidden as a 404 (resource-hiding house rule), never a 403 — both
// "not a member" and "not allowed" collapse to the same Not-Found.

import type { Env } from "./env.js";
import type { ActorContext } from "./router.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type { Uuid } from "@saas/db/ids";
import { errorResponse } from "./http.js";
import { fetchAuthorizationContext } from "./membership-client.js";
import { authorizeViaPolicy } from "./policy-client.js";

/** `{ ok: true }` to proceed; otherwise a ready-to-return error Response. */
export type AuthzResult = { ok: true } | { ok: false; response: Response };

/**
 * Authorize `action` for `actor` on the (org, project) resource. Returns a 404
 * (not 403) on any denial or missing-membership, per resource-hiding.
 *
 * Internal-service convention (matches projects-worker, config-worker, etc.):
 * pass bare UUIDs — membership-worker's authorization-context handler calls
 * `asUuid()` on req.orgId and throws on non-canonical input, which would
 * surface as a 500 here and a 404 to the caller. The policy-engine matches
 * `fact.scope.orgId === resource.orgId` by string equality, and membership-
 * worker propagates whatever we send into scope.orgId; the resource and the
 * facts must therefore share the same format.
 */
export async function authorizeRun(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  action: string,
): Promise<AuthzResult> {
  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return {
      ok: false,
      response: errorResponse(
        "internal_error",
        "Authorization services not configured",
        503,
        requestId,
      ),
    };
  }

  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) {
    return { ok: false, response: errorResponse("not_found", "Not found", 404, requestId) };
  }

  const resource: PolicyResource = {
    kind: "project",
    orgId,
    projectId,
  };
  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    action,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return { ok: false, response: errorResponse("not_found", "Not found", 404, requestId) };
  }

  return { ok: true };
}
