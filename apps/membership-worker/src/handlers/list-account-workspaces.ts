import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository } from "@saas/db/membership";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse } from "../http.js";
import { parseOrgPublicId, orgPublicId } from "../ids.js";

/**
 * GET /v1/organizations/{accountId}/workspaces — list the child workspaces under
 * an Account (saas-integration-tenancy IT12). Backs the grant-management picker:
 * an account admin admits a workspace by selecting it, not by pasting an id.
 *
 * Authorized with the org read action (`organization.member.list`) on the
 * account — deny-by-default. Returns `{ workspaces: [{ orgId, workspaceRef,
 * name }] }`; an account with no children returns `[]`.
 */
export interface ListAccountWorkspacesDeps {
  repo: Pick<MembershipRepository, "listRoleAssignments" | "listChildOrganizations">;
}

export async function handleListAccountWorkspaces(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: ListAccountWorkspacesDeps,
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

    const rolesResult = await repo.listRoleAssignments(orgUuid, actor.subjectId);
    if (!rolesResult.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const authResult = await authorizeViaPolicy(env.POLICY_WORKER, {
      actor,
      action: "organization.member.list",
      resource: { kind: "organization", id: orgUuid, orgId: orgUuid },
      orgId: orgUuid,
      roleAssignments: rolesResult.value,
      requestId,
    });
    if (!authResult.allow) {
      // Deny-by-default; do not disclose the resource.
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const children = await repo.listChildOrganizations(orgUuid);
    if (!children.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    return successResponse(
      {
        workspaces: children.value.map((c) => ({
          orgId: orgPublicId(c.id),
          workspaceRef: c.publicRef,
          name: c.name,
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
