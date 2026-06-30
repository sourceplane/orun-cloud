import type { Env } from "../env.js";
import type { AuthorizationContextRequest, AuthorizationContextResponse } from "@saas/contracts/policy";
import type { MembershipRepository } from "@saas/db/membership";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { mapRoleAssignmentsToFacts } from "../membership-facts.js";
import { errorResponse, successResponse, validationError } from "../http.js";

const SUBJECT_TYPES = new Set(["user", "service_principal", "workflow", "system"]);

export interface HandleAuthorizationContextDeps {
  repo?: MembershipRepository;
}

export async function handleAuthorizationContext(
  request: Request,
  env: Env,
  requestId: string,
  deps?: HandleAuthorizationContextDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
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

  const typedReq: AuthorizationContextRequest = {
    subject: { type: subject.type as AuthorizationContextRequest["subject"]["type"], id: subject.id },
    orgId: req.orgId,
  };

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB);
  const repo = deps?.repo ?? createMembershipRepository(executor!);

  try {
    const targetOrgUuid = asUuid(typedReq.orgId);
    const rolesResult = await repo.listRoleAssignments(targetOrgUuid, typedReq.subject.id);
    if (!rolesResult.ok) {
      return errorResponse("internal_error", "Failed to retrieve authorization context", 500, requestId);
    }

    // Org/project facts held directly on the target org. Any account-scoped rows
    // returned here (the case where the target IS the account root) are preserved
    // by the mapper and cascade onto the target via the engine's account catalog.
    const memberships = mapRoleAssignmentsToFacts(typedReq.orgId, rolesResult.value);

    // Account-scoped RBAC cascade (saas-workspace-id WID6 — design §8.2). If the
    // target is a CHILD workspace, also surface the actor's account-scoped roles,
    // which live on the account (parent) org. We remap them onto the target orgId
    // so the policy engine's `scope.orgId === orgId` filter matches and the
    // account role cascades down. Fail-soft: if the org fetch fails we fall back
    // to org/project facts only (today's behavior).
    try {
      const orgResult = await repo.getOrganizationById(targetOrgUuid);
      if (orgResult.ok) {
        const accountUuid = effectiveBillingOrgId(orgResult.value);
        if (accountUuid !== targetOrgUuid) {
          const accountRolesResult = await repo.listRoleAssignments(
            asUuid(accountUuid),
            typedReq.subject.id,
          );
          if (accountRolesResult.ok) {
            const accountAssignments = accountRolesResult.value.filter(
              (ra) => ra.scopeKind === "account",
            );
            // Stamp the cascaded account facts with the TARGET orgId.
            memberships.push(...mapRoleAssignmentsToFacts(typedReq.orgId, accountAssignments));
          }
        }
      }
    } catch {
      // Fail-soft — keep org/project facts only.
    }

    const responseBody: AuthorizationContextResponse = { memberships };

    return successResponse(responseBody, requestId);
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown; code?: unknown };
    console.error("[membership] authorization-context failed", {
      requestId,
      name: typeof e?.name === "string" ? e.name : undefined,
      message: typeof e?.message === "string" ? e.message : undefined,
      code: typeof e?.code === "string" ? e.code : undefined,
    });
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
