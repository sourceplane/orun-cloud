import type { Env } from "../env.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createMembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId } from "../ids.js";

export interface HandleSubjectOrgsDeps {
  repo?: MembershipRepository;
}

/**
 * Internal endpoint (identity-worker → membership-worker): the orgs a subject
 * belongs to, joined with their org-level role. Backs the CLI session payload's
 * `orgs:[{id,slug,name,role}]` (OP1). Org-independent: the subject is the
 * authenticated CLI user; deny-by-default policy still gates the per-org state
 * routes the CLI subsequently calls.
 *
 * POST /v1/internal/membership/subject-orgs  { subject: { type, id } }
 */
export async function handleSubjectOrgs(
  request: Request,
  env: Env,
  requestId: string,
  deps?: HandleSubjectOrgsDeps,
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
  if (!req.subject || typeof req.subject !== "object") {
    return validationError(requestId, { subject: ["Required"] });
  }
  const subject = req.subject as Record<string, unknown>;
  if (typeof subject.id !== "string" || subject.id.length === 0) {
    return validationError(requestId, { "subject.id": ["Required"] });
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  const repo = deps?.repo ?? createMembershipRepository(executor!);
  try {
    const result = await repo.listOrganizationsWithRoleForSubject(subject.id);
    if (!result.ok) {
      return errorResponse("internal_error", "Failed to list organizations", 500, requestId);
    }
    const orgs = result.value
      .filter((o) => o.status === "active")
      .map((o) => ({
        id: orgPublicId(o.id),
        slug: o.slug,
        name: o.name,
        role: o.role,
      }));
    return successResponse({ orgs }, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
