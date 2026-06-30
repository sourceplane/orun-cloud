import type { Env } from "../env.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository } from "@saas/db/membership";
import { successResponse, errorResponse } from "../http.js";
import { parseOrgPublicId, orgPublicId } from "../ids.js";

/**
 * Internal, service-binding-only resolution of an org to the **Account** that
 * owns its shared GitHub connection (epic `saas-integration-tenancy`, IT10).
 * Used by integrations-worker so a child workspace's Integrations list can show
 * the account's `account`-scoped connections as inherited, attributed by the
 * account's `ws_…` + name.
 *
 * Returns `{ isChild: false, account: null }` for a standalone/account-root org
 * (nothing resolves up); `{ isChild: true, account: {...} }` for a child.
 * Fails closed on a missing org (`404`); the caller treats any failure as "no
 * inherited connections" so the child's own list still renders.
 */
export interface ResolveIntegrationParentDeps {
  repo?: Pick<MembershipRepository, "getOrganizationById">;
}

export async function handleResolveIntegrationParent(
  request: Request,
  env: Env,
  requestId: string,
  deps: ResolveIntegrationParentDeps = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
  }
  if (!deps.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const raw = (body as { orgId?: unknown } | null)?.orgId;
  if (typeof raw !== "string") {
    return errorResponse("bad_request", "orgId is required", 400, requestId);
  }
  const hex = parseOrgPublicId(raw);
  if (!hex) {
    return errorResponse("bad_request", "orgId is malformed", 400, requestId);
  }

  const executor = deps.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps.repo ?? createMembershipRepository(executor!);
    const child = await repo.getOrganizationById(hex);
    if (!child.ok) {
      if (child.error.kind === "not_found") {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
      return errorResponse("internal_error", "Failed to resolve integration parent", 503, requestId);
    }
    if (child.value.parentOrgId === null) {
      return successResponse({ orgId: raw, isChild: false, account: null }, requestId);
    }
    const parent = await repo.getOrganizationById(child.value.parentOrgId);
    if (!parent.ok) {
      return errorResponse("internal_error", "Failed to resolve integration parent", 503, requestId);
    }
    return successResponse(
      {
        orgId: raw,
        isChild: true,
        account: {
          orgId: orgPublicId(parent.value.id),
          workspaceRef: parent.value.publicRef,
          name: parent.value.name,
        },
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Failed to resolve integration parent", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
