// Org state-plane storage footprint (OV9 — the over-quota story's STOCK gauge).
//
// GET /v1/organizations/{orgId}/catalog/entities's sibling: an org-scoped read
// (no project) that aggregates the org's live object + log-chunk indexes into a
// current count + byte total. Distinct from the metering FLOW metrics
// (state.object_bytes etc., which sum volume pushed in a window) — this is what
// the org is storing right now, the basis a storage quota would check against.
//
// Org-scoped read, gated on catalog.read on the organization (same surface as
// the org-global catalog browser).

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { GetStateStorageResponse } from "@saas/contracts/state";
import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import { createStateRepository } from "@saas/db/state";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse } from "../http.js";
import { authorizeOrg } from "../authz.js";

export interface StateUsageHandlerDeps {
  executor?: SqlExecutor;
}

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

export async function handleGetOrgStateStorage(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: StateUsageHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, STATE_POLICY_ACTIONS.CATALOG_READ);
  if (!authz.ok) return authz.response;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.getOrgStateStorage(orgId);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const payload: GetStateStorageResponse = { usage: result.value };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}
