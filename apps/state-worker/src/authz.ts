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
import type { StateRepository } from "@saas/db/state";
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
  // Workflow actors (OV3 — credential-agnostic CI auth). The OIDC exchange
  // already verified the GitHub token, resolved the repo to this (org, project),
  // and gated on the link's CI settings; the minted token's bound scope IS the
  // authorization. So a workflow grant is exactly: the request's (org, project)
  // equals the token's bound (org, project) — no role lookup (a workflow has no
  // memberships). A mismatch (or a workflow token with no bound scope) hides as
  // a 404, like every other denial.
  if (actor.subjectType === "workflow") {
    if (
      actor.boundOrgId &&
      actor.boundProjectId &&
      actor.boundOrgId === orgId &&
      actor.boundProjectId === projectId
    ) {
      return { ok: true };
    }
    return { ok: false, response: errorResponse("not_found", "Not found", 404, requestId) };
  }

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

/**
 * Authorize `action` for `actor` on the ORG resource (no project) — the org-
 * global surfaces (OV6 catalog browser). Same deny-as-404 resource-hiding as
 * authorizeRun. A workflow token is scoped to one (org, project), so it may read
 * org-global data only for its own org; everything else hides as a 404.
 */
export async function authorizeOrg(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  action: string,
): Promise<AuthzResult> {
  if (actor.subjectType === "workflow") {
    if (actor.boundOrgId && actor.boundOrgId === orgId) return { ok: true };
    return { ok: false, response: errorResponse("not_found", "Not found", 404, requestId) };
  }

  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return {
      ok: false,
      response: errorResponse("internal_error", "Authorization services not configured", 503, requestId),
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

  const resource: PolicyResource = { kind: "organization", orgId };
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

/**
 * Repo allow-list gate for OIDC-CI state-object pushes.
 *
 * The OIDC token was minted only because the repo had an active workspace link
 * (the allow-list entry), but that was checked at MINT time. This re-checks at
 * PUSH time so unlinking a repo immediately revokes a workflow's ability to
 * commit objects — even with a token minted earlier (defense-in-depth). The
 * gate is workflow-only: human / CLI / service-principal actors are governed by
 * role policy in `authorizeRun` and are unaffected. A missing allow-list entry
 * hides as a 404, like every other denial.
 *
 * Callers must have already passed `authorizeRun(..., OBJECT_WRITE)`; this is the
 * second, allow-list gate layered on top, run when an object is about to be
 * committed (single-request PUT and multipart complete).
 */
export async function requireWorkflowRepoAllowed(
  repo: Pick<StateRepository, "hasActiveWorkspaceLink">,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
): Promise<AuthzResult> {
  if (actor.subjectType !== "workflow") return { ok: true };
  const linked = await repo.hasActiveWorkspaceLink(orgId, projectId);
  if (!linked.ok) {
    return {
      ok: false,
      response: errorResponse("internal_error", "Service unavailable", 503, requestId),
    };
  }
  if (!linked.value) {
    return { ok: false, response: errorResponse("not_found", "Not found", 404, requestId) };
  }
  return { ok: true };
}
