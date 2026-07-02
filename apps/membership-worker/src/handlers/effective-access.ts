import type { Env } from "../env.js";
import type { EffectiveAccessResponse, PolicySubject } from "@saas/contracts/policy";
import type { MembershipRepository } from "@saas/db/membership";
import { createMembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { assembleAuthorizationFacts } from "../authz-facts.js";
import { effectivePermissionsViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";

const SUBJECT_TYPES = new Set(["user", "service_principal", "workflow", "system"]);

export interface HandleEffectiveAccessDeps {
  repo?: MembershipRepository;
}

/**
 * Effective-access read (saas-teams TM6b2). For an actor on a target
 * org (optionally narrowed to a project), assemble the same provenance-carrying
 * facts as the authorization context and run the policy engine's
 * effective-permissions, returning each permitted action with its `via`
 * provenance (direct / team / account cascade).
 *
 * Internal, service-binding-only (mirrors authorization-context): the subject is
 * supplied in the body, so a future api-edge route can request either the
 * caller's own access or — gated by admin authority — another subject's.
 */
export async function handleEffectiveAccess(
  request: Request,
  env: Env,
  requestId: string,
  deps?: HandleEffectiveAccessDeps,
): Promise<Response> {
  if (!deps?.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!env.POLICY_WORKER) {
    return errorResponse("internal_error", "Policy service unavailable", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be an object"] });
  }
  const req = body as Record<string, unknown>;

  if (!req.subject || typeof req.subject !== "object") {
    return validationError(requestId, { subject: ["Required"] });
  }
  const subject = req.subject as Record<string, unknown>;
  if (typeof subject.type !== "string" || !SUBJECT_TYPES.has(subject.type)) {
    return validationError(requestId, { "subject.type": ["Must be one of: user, service_principal, workflow, system"] });
  }
  if (typeof subject.id !== "string" || subject.id.length === 0) {
    return validationError(requestId, { "subject.id": ["Required"] });
  }
  if (typeof req.orgId !== "string" || req.orgId.length === 0) {
    return validationError(requestId, { orgId: ["Required"] });
  }
  const projectId = typeof req.projectId === "string" && req.projectId.length > 0 ? req.projectId : undefined;

  const policySubject: PolicySubject = {
    type: subject.type as PolicySubject["type"],
    id: subject.id,
  };

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  const repo = deps?.repo ?? createMembershipRepository(executor!);

  try {
    const memberships = await assembleAuthorizationFacts(repo, policySubject.id, req.orgId);
    const permissions = await effectivePermissionsViaPolicy(env.POLICY_WORKER, {
      subject: policySubject,
      resource: { kind: "organization", orgId: req.orgId, ...(projectId ? { projectId } : {}) },
      memberships,
      requestId,
    });
    const responseBody: EffectiveAccessResponse = { permissions };
    return successResponse(responseBody, requestId);
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown; code?: unknown };
    console.error("[membership] effective-access failed", {
      requestId,
      name: typeof e?.name === "string" ? e.name : undefined,
      message: typeof e?.message === "string" ? e.message : undefined,
    });
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
