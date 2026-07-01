import type { Env } from "../env.js";
import type { AuthorizationContextRequest, AuthorizationContextResponse } from "@saas/contracts/policy";
import type { MembershipRepository } from "@saas/db/membership";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid, type Uuid } from "@saas/db/ids";
import type { RoleAssignment } from "@saas/db/membership";
import { mapRoleAssignmentsToFacts } from "../membership-facts.js";
import { teamPublicId } from "../ids.js";
import { errorResponse, successResponse, validationError } from "../http.js";

const SUBJECT_TYPES = new Set(["user", "service_principal", "workflow", "system"]);

export interface HandleAuthorizationContextDeps {
  repo?: MembershipRepository;
}

/**
 * All active grants held by a set of subjects on one org. Prefers the batched
 * `listRoleAssignmentsForSubjects` (one query, PERF3); falls back to per-subject
 * `listRoleAssignments` when a repo/fake omits the batch method.
 */
async function grantsForSubjects(
  repo: MembershipRepository,
  orgUuid: Uuid,
  subjectIds: string[],
): Promise<RoleAssignment[]> {
  if (subjectIds.length === 0) return [];
  if (repo.listRoleAssignmentsForSubjects) {
    const res = await repo.listRoleAssignmentsForSubjects(orgUuid, subjectIds);
    if (!res.ok) return [];
    return Array.from(res.value.values()).flat();
  }
  const out: RoleAssignment[] = [];
  for (const sid of subjectIds) {
    const res = await repo.listRoleAssignments(orgUuid, sid);
    if (res.ok) out.push(...res.value);
  }
  return out;
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
        const isChild = accountUuid !== targetOrgUuid;

        // (A) User account-scope cascade (WID6). Only when the target is a CHILD
        // workspace: surface the actor's own account-scoped roles (which live on
        // the account org), remapped onto the target orgId.
        if (isChild) {
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

        // (B) Team-derived facts (saas-teams TM3). Teams are account-owned, so
        // resolve the actor's active teams within the account, then expand the
        // grants those teams hold into the actor's facts. Short-circuit entirely
        // when the actor is in no team, so team-less accounts add zero grant
        // queries on this hot path. The policy engine is unchanged — a team fact
        // is a role_assignment fact like any other (it never sees subject_type).
        const teamsResult = await repo.listTeamsForSubject(asUuid(accountUuid), typedReq.subject.id);
        if (teamsResult.ok && teamsResult.value.length > 0) {
          const teamPublicIds = teamsResult.value.map((t) => teamPublicId(t.id));

          // Grants these teams hold on the TARGET org (organization/project scope,
          // and — when the target IS the account root — account scope too). The
          // mapper stamps each onto the target orgId by its own scope kind.
          const targetTeamGrants = await grantsForSubjects(repo, targetOrgUuid, teamPublicIds);
          memberships.push(...mapRoleAssignmentsToFacts(typedReq.orgId, targetTeamGrants));

          // Account-scope grants these teams hold on the ACCOUNT org cascade down
          // to a child workspace (mirrors the user cascade in (A)). Only account
          // scope cascades; an org-scope grant on the account stays on the account.
          if (isChild) {
            const accountTeamGrants = (
              await grantsForSubjects(repo, asUuid(accountUuid), teamPublicIds)
            ).filter((ra) => ra.scopeKind === "account");
            memberships.push(...mapRoleAssignmentsToFacts(typedReq.orgId, accountTeamGrants));
          }
        }
      }
    } catch {
      // Fail-soft — keep direct org/project facts only.
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
