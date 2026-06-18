// Object GC reachability report (OV9 — REPORT-ONLY; design-v2 §9).
//
// GET /v1/organizations/{orgId}/projects/{projectId}/state/gc/report — an
// operator-triggered, on-demand diagnostic: how much of the project's object
// store is unreachable from any live pointer (refs + catalog heads + run plans),
// i.e. what a future GC could reclaim. Computes only — DELETES NOTHING. Project-
// scoped read, gated on state.object.read.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { GetStateGcReportResponse } from "@saas/contracts/state";
import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse } from "../http.js";
import { authorizeRun } from "../authz.js";
import { computeStorageGcReport, type StorageGcReportDeps } from "../gc-reachability.js";
import { orgPublicId, projectPublicId } from "../ids.js";

export interface GcReportHandlerDeps {
  executor?: SqlExecutor;
  fetcher?: StorageGcReportDeps["fetcher"];
}

export async function handleGetStateGcReport(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: GcReportHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_READ);
  if (!authz.ok) return authz.response;

  try {
    const scope = {
      orgId,
      projectId,
      orgPublic: orgPublicId(orgId),
      projectPublic: projectPublicId(projectId),
    };
    const report = await computeStorageGcReport(env, scope, {
      ...(deps?.executor ? { executor: deps.executor } : {}),
      ...(deps?.fetcher ? { fetcher: deps.fetcher } : {}),
    });
    if (!report) {
      // Storage unavailable (no R2 binding / DB) — report-only is dormant here.
      return errorResponse("unavailable", "Object storage is not available in this environment.", 503, requestId);
    }
    const payload: GetStateGcReportResponse = { report };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
