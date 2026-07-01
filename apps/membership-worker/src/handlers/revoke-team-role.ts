import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { asUuid } from "@saas/db/ids";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, parseTeamPublicId } from "../ids.js";

const SCOPE_KINDS = new Set(["account", "organization", "project"]);

export interface RevokeTeamRoleDeps {
  repo: Pick<
    MembershipRepository,
    "getOrganizationById" | "getTeamById" | "listRoleAssignments" | "revokeTeamGrant"
  >;
  now?: () => Date;
}

/**
 * Revoke a Team grant (saas-teams TM2). Identified by its tuple (team + role +
 * scope) — the partial-unique index makes at most one active row match. Authority
 * follows the grant's scope, exactly like the grant path
 * (`organization.member.update_role` on the account org for account scope, else
 * the target org).
 */
export async function handleRevokeTeamRole(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: RevokeTeamRoleDeps,
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be an object"] });
  }
  const { teamId, role, scopeKind, scopeRef } = body as {
    teamId?: unknown;
    role?: unknown;
    scopeKind?: unknown;
    scopeRef?: unknown;
  };

  if (typeof teamId !== "string" || !parseTeamPublicId(teamId)) {
    return validationError(requestId, { teamId: ["Must be a valid team id (team_…)"] });
  }
  if (typeof role !== "string" || role.length === 0) {
    return validationError(requestId, { role: ["Required"] });
  }
  if (typeof scopeKind !== "string" || !SCOPE_KINDS.has(scopeKind)) {
    return validationError(requestId, { scopeKind: ["Must be one of: account, organization, project"] });
  }
  let scopeRefValue: string | null = null;
  if (scopeKind === "project") {
    if (typeof scopeRef !== "string" || scopeRef.length === 0) {
      return validationError(requestId, { scopeRef: ["Required for project scope"] });
    }
    scopeRefValue = scopeRef;
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    const orgResult = await repo.getOrganizationById(orgUuid);
    if (!orgResult.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const accountUuid = asUuid(effectiveBillingOrgId(orgResult.value));

    const authorityOrg = scopeKind === "account" ? accountUuid : orgUuid;

    const actorRoles = await repo.listRoleAssignments(authorityOrg, actor.subjectId);
    if (!actorRoles.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const authResult = await authorizeViaPolicy(env.POLICY_WORKER, {
      actor,
      action: "organization.member.update_role",
      resource: { kind: "organization", id: authorityOrg, orgId: authorityOrg },
      orgId: authorityOrg,
      roleAssignments: actorRoles.value,
      requestId,
    });
    if (!authResult.allow) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const revoked = await repo.revokeTeamGrant(authorityOrg, teamId, role, scopeKind, scopeRefValue, now);
    if (!revoked.ok) {
      if (revoked.error.kind === "not_found") {
        return errorResponse("not_found", "Grant not found", 404, requestId);
      }
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    return successResponse(
      { grant: { teamId, role, scopeKind, scopeRef: scopeRefValue, revoked: true } },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
