// Log append/read (state-api-contract §2.3). DEFERRED to OP3 (the object/log
// plane), where the R2-backed chunk store lands. OP2 ships the run-coordination
// plane only; building half an R2 log store here would be worse than a clear
// stub. These handlers authenticate + authorize like every state route, then
// return a clean `501 not_implemented` so clients get an actionable signal
// rather than a 404 (the routes EXIST; the behavior arrives in OP3).

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import type { Uuid } from "@saas/db/ids";
import { errorResponse } from "../http.js";
import { authorizeRun } from "../authz.js";

export async function handleAppendLog(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
): Promise<Response> {
  // Append is a write; gate on state.run.write (per §6 "log append").
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!authz.ok) return authz.response;
  return notImplemented(requestId);
}

export async function handleReadLog(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
): Promise<Response> {
  // Read is gated on state.run.read (per §6 "logs read").
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_READ);
  if (!authz.ok) return authz.response;
  return notImplemented(requestId);
}

function notImplemented(requestId: string): Response {
  return errorResponse(
    "not_implemented",
    "Log append/read lands in OP3 (the object/log plane). The route exists; the behavior is not yet available.",
    501,
    requestId,
    { milestone: "OP3" },
  );
}
