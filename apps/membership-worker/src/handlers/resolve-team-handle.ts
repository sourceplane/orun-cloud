import type { Env } from "../env.js";
import type { MembershipRepository } from "@saas/db/membership";
import type { ResolveTeamHandleResponse } from "@saas/contracts/membership";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, teamPublicId } from "../ids.js";

export interface ResolveTeamHandleDeps {
  repo?: MembershipRepository;
}

/**
 * Internal endpoint (service-binding only): resolve a team `@handle` mention to
 * its `team_<hex>` id, scoped to the org's account (teams-collaboration TC2).
 * Handles are account-unique, so the org is resolved to its billing/account org
 * first, then the team is looked up by (account, handle). A leading `@` on the
 * handle is tolerated. An unknown handle returns `{ teamId: null }` (a 200, not
 * an error) so a caller can fall back to an org default cleanly.
 *
 * POST /v1/internal/membership/resolve-team-handle  { orgId, handle }
 */
export async function handleResolveTeamHandle(
  request: Request,
  env: Env,
  requestId: string,
  deps?: ResolveTeamHandleDeps,
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
  if (typeof req.orgId !== "string" || req.orgId.length === 0) {
    return validationError(requestId, { orgId: ["Required"] });
  }
  if (typeof req.handle !== "string" || req.handle.length === 0) {
    return validationError(requestId, { handle: ["Required"] });
  }
  const orgUuid = parseOrgPublicId(req.orgId);
  if (!orgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }
  const handleLower = req.handle.replace(/^@/, "").toLowerCase();
  if (handleLower.length === 0) {
    return validationError(requestId, { handle: ["Required"] });
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  const repo = deps?.repo ?? createMembershipRepository(executor!);
  try {
    const orgResult = await repo.getOrganizationById(orgUuid);
    if (!orgResult.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    const accountUuid = asUuid(effectiveBillingOrgId(orgResult.value));
    const team = await repo.getTeamByHandle(accountUuid, handleLower);
    const response: ResolveTeamHandleResponse = team.ok
      ? { teamId: teamPublicId(team.value.id), handle: team.value.handle, name: team.value.name }
      : { teamId: null, handle: null, name: null };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
