// Session-event read handler (saas-agents AG6). The relay mirror of the orun
// runtime's append-only log, for console snapshot + replay. The append/ingest
// path (from the in-sandbox runtime over the DO relay) is a later AG6 slice;
// here we serve the read.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import { errorResponse, listResponse, notFound } from "../http.js";
import { toPublicEvent } from "../mappers.js";

export async function handleListSessionEvents(
  deps: AgentsDeps,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.session.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const session = await deps.repo.getSession({ orgId }, sessionId);
  if (!session) return notFound(requestId, sessionId);
  const events = await deps.repo.listSessionEvents({ orgId }, sessionId);
  return listResponse(events.map(toPublicEvent), requestId, null);
}
