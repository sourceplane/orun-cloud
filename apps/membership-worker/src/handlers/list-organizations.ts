import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId } from "../ids.js";
import { parsePageParams, encodeCursor } from "../pagination.js";

export interface ListOrganizationsDeps {
  /** Inject a repository in tests; falls back to a Hyperdrive-backed repo. */
  repo?: Pick<MembershipRepository, "listOrganizationsForSubjectPaged" | "getOrganizationsByIds">;
}

export async function handleListOrganizations(
  env: Env,
  requestId: string,
  actor: ActorContext,
  url: URL,
  deps: ListOrganizationsDeps = {},
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const pageResult = parsePageParams(url);
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }
  const { limit, cursor } = pageResult.value;

  const executor = deps.repo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps.repo ?? createMembershipRepository(executor!);
    const result = await repo.listOrganizationsForSubjectPaged(actor.subjectId, {
      limit,
      cursor: cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null,
    });

    if (!result.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    const { items, nextCursor } = result.value;

    // Resolve each org's Account (`ws_…`) id (WID4). The account UUID is
    // `effectiveBillingOrgId(org) = parentOrgId ?? id`. For a root that is the
    // org itself (publicRef known locally); for a child it is the parent's
    // publicRef, which needs a lookup. Batch the DISTINCT parent ids into one
    // query to avoid an N+1 over the page.
    const selfRefByUuid = new Map<string, string>(items.map((org) => [org.id, org.publicRef]));
    const parentIds = [
      ...new Set(items.map((org) => org.parentOrgId).filter((id): id is string => id != null && !selfRefByUuid.has(id))),
    ];
    const parentRefByUuid = new Map<string, string>();
    if (parentIds.length > 0) {
      const parentsResult = await repo.getOrganizationsByIds(parentIds);
      if (!parentsResult.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
      for (const parent of parentsResult.value) {
        parentRefByUuid.set(parent.id, parent.publicRef);
      }
    }

    const organizations = items.map((org) => {
      const isAccountRoot = org.parentOrgId == null;
      const accountUuid = effectiveBillingOrgId(org);
      const accountId = selfRefByUuid.get(accountUuid) ?? parentRefByUuid.get(accountUuid);
      return {
        id: orgPublicId(org.id),
        name: org.name,
        slug: org.slug,
        workspaceRef: org.publicRef,
        accountId,
        kind: isAccountRoot ? ("account" as const) : ("workspace" as const),
        isAccountRoot,
        status: org.status,
        createdAt: org.createdAt.toISOString(),
      };
    });

    const cursorToken = nextCursor ? encodeCursor(nextCursor.createdAt, nextCursor.id) : null;
    return successResponse({ organizations }, requestId, 200, cursorToken);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await executor?.dispose();
  }
}
