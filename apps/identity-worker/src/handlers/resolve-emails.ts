import type { Env } from "../env.js";
import type { IdentityRepository } from "@saas/db/identity";
import type { ResolveEmailsResponse } from "@saas/contracts/auth";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createIdentityRepository } from "@saas/db/identity";
import { successResponse, errorResponse, validationError } from "../http.js";

export interface ResolveEmailsDeps {
  repo?: IdentityRepository;
}

/**
 * Internal endpoint (notifications-worker → identity-worker): resolve opaque
 * user subject ids (`usr_…`) to their delivery email addresses. Backs the
 * teams-collaboration TC1 team-target fan-out — the membership roster returns
 * subject ids and this maps each to an address.
 *
 * Service-binding only (not routed by api-edge). Active users only; subjects
 * that do not resolve to an active user are omitted, so the response is not a
 * 1:1 mapping of the request.
 *
 * POST /v1/internal/identity/resolve-emails  { subjectIds: string[] }
 */
export async function handleResolveEmails(
  request: Request,
  env: Env,
  requestId: string,
  deps?: ResolveEmailsDeps,
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
  if (!Array.isArray(req.subjectIds) || req.subjectIds.some((s) => typeof s !== "string")) {
    return validationError(requestId, { subjectIds: ["Must be an array of strings"] });
  }
  // Bound the batch so a hostile/oversized request can't fan out an unbounded
  // IN-list. Teams are small; 500 is comfortably above any real roster.
  if (req.subjectIds.length > 500) {
    return validationError(requestId, { subjectIds: ["At most 500 ids per request"] });
  }

  const ids = [...new Set(req.subjectIds as string[])].filter((s) => s.length > 0);

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  const repo = deps?.repo ?? createIdentityRepository(executor!);
  try {
    const result = await repo.listUsersByIds(ids);
    if (!result.ok) {
      return errorResponse("internal_error", "Failed to resolve emails", 500, requestId);
    }
    const response: ResolveEmailsResponse = {
      users: result.value.map((u) => ({ subjectId: u.id, email: u.email })),
    };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
