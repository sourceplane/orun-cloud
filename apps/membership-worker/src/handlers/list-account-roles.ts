import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { asUuid } from "@saas/db/ids";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse } from "../http.js";
import { parseOrgPublicId } from "../ids.js";

export interface ListAccountRolesDeps {
  repo: Pick<
    MembershipRepository,
    "getOrganizationById" | "listRoleAssignments" | "listAccountRoleAssignments"
  >;
}

/**
 * GET /v1/organizations/{orgId}/account-roles — list the account's active
 * account-scoped role assignments (teams-hub TH1a; closes the list half WID6
 * deferred).
 *
 * The path org may be the account itself or any workspace under it — the
 * handler resolves up via `effectiveBillingOrgId`, exactly like the grant
 * path, so the same URL shape works from either context. Rows cover every
 * subject type: user grants (WID6) and team grants at account scope (TM2),
 * each labeled by `subjectType` so the hub can render both honestly.
 *
 * Gate: `organization.member.list` on the ACCOUNT org — the same read gate as
 * the workspace roster (IT12). A workspace-only member holds no role on the
 * account and is denied (surfaced as not_found).
 */
export async function handleListAccountRoles(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: ListAccountRolesDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }
  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }
  if (!env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    const orgResult = await repo.getOrganizationById(orgUuid);
    if (!orgResult.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const accountUuid = asUuid(effectiveBillingOrgId(orgResult.value));

    const actorRoles = await repo.listRoleAssignments(accountUuid, actor.subjectId);
    if (!actorRoles.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const authResult = await authorizeViaPolicy(env.POLICY_WORKER, {
      actor,
      action: "organization.member.list",
      resource: { kind: "organization", id: accountUuid, orgId: accountUuid },
      orgId: accountUuid,
      roleAssignments: actorRoles.value,
      requestId,
    });
    if (!authResult.allow) {
      // Deny-by-default; do not disclose the resource.
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const assignments = await repo.listAccountRoleAssignments(accountUuid);
    if (!assignments.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    return successResponse(
      {
        assignments: assignments.value.map((a) => ({
          subjectId: a.subjectId,
          subjectType: a.subjectType,
          role: a.role,
          createdAt: a.createdAt.toISOString(),
        })),
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
