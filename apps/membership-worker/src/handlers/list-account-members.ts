import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { asUuid } from "@saas/db/ids";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse } from "../http.js";
import { parseOrgPublicId } from "../ids.js";

export interface ListAccountMembersDeps {
  repo: Pick<
    MembershipRepository,
    "getOrganizationById" | "listRoleAssignments" | "listMembers" | "listAccountRoleAssignments"
  >;
}

/** How a subject reaches the account roster (teams-hub TH1b, design §2). */
type RosterOrigin = "member" | "account_role" | "both";

/**
 * GET /v1/organizations/{orgId}/account-members — the DERIVED account-member
 * roster (teams-hub TH1b). There is no account_members table and this adds
 * none (membership stays per-org, design §2): the roster is the union of
 *
 *   (a) the account ROOT org's active organization members, and
 *   (b) user subjects holding an ACTIVE account-scoped role assignment.
 *
 * Each row is tagged `origin: member | account_role | both`, so the hub can
 * finally show the cascade admins who appear in NO workspace member list —
 * the legibility gap the epic calls out. Team subjects at (b) are excluded:
 * this is a people roster; teams show on the Roles surface.
 *
 * The path org may be the account or any child workspace (resolves up via
 * `effectiveBillingOrgId`). Gate: `organization.member.list` on the ACCOUNT
 * org, deny-by-default.
 */
export async function handleListAccountMembers(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: ListAccountMembersDeps,
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

    const [membersResult, accountRolesResult] = await Promise.all([
      repo.listMembers(accountUuid),
      repo.listAccountRoleAssignments(accountUuid),
    ]);
    if (!membersResult.ok || !accountRolesResult.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    // Union, keyed by subject. Roster rows are people: user account-role
    // holders merge in; team grants are the Roles surface's concern.
    const rows = new Map<
      string,
      { subjectId: string; subjectType: string; origin: RosterOrigin; status?: string; joinedAt?: string; accountRoles: string[] }
    >();
    for (const m of membersResult.value) {
      if (m.status !== "active") continue;
      rows.set(m.subjectId, {
        subjectId: m.subjectId,
        subjectType: m.subjectType,
        origin: "member",
        status: m.status,
        joinedAt: m.createdAt.toISOString(),
        accountRoles: [],
      });
    }
    for (const a of accountRolesResult.value) {
      if (a.subjectType !== "user") continue;
      const existing = rows.get(a.subjectId);
      if (existing) {
        existing.origin = "both";
        existing.accountRoles.push(a.role);
      } else {
        rows.set(a.subjectId, {
          subjectId: a.subjectId,
          subjectType: a.subjectType,
          origin: "account_role",
          accountRoles: [a.role],
        });
      }
    }

    return successResponse({ members: [...rows.values()] }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
