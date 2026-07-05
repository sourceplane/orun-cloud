import type { Env } from "../env.js";
import type { MembershipRepository } from "@saas/db/membership";
import type { InternalTeamMembersResponse } from "@saas/contracts/membership";
import { createMembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseTeamPublicId } from "../ids.js";

export interface InternalTeamMembersDeps {
  repo?: MembershipRepository;
}

/**
 * Internal endpoint (notifications-worker → membership-worker): the active
 * roster of a team, for notification fan-out (teams-collaboration TC1). The
 * roster is read live, so a membership change is reflected on the next send
 * with no backfill.
 *
 * Service-binding only (not routed by api-edge) — trust is the binding, as with
 * the sibling `/v1/internal/membership/*` routes. Returns only `active` members;
 * the caller filters to user subjects before resolving delivery emails.
 *
 * POST /v1/internal/membership/team-members  { teamId }
 */
export async function handleInternalTeamMembers(
  request: Request,
  env: Env,
  requestId: string,
  deps?: InternalTeamMembersDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB && !deps?.repo) {
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
  if (typeof req.teamId !== "string" || req.teamId.length === 0) {
    return validationError(requestId, { teamId: ["Required"] });
  }
  const teamUuid = parseTeamPublicId(req.teamId);
  if (!teamUuid) {
    return errorResponse("not_found", "Team not found", 404, requestId);
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  const repo = deps?.repo ?? createMembershipRepository(executor!);
  try {
    const result = await repo.listTeamMembers(teamUuid);
    if (!result.ok) {
      return errorResponse("internal_error", "Failed to list team members", 500, requestId);
    }
    // repo.listTeamMembers already filters to status = 'active'.
    const response: InternalTeamMembersResponse = {
      members: result.value.map((m) => ({
        subjectId: m.subjectId,
        subjectType: m.subjectType,
        teamRole: m.teamRole,
      })),
    };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
