// Agent-session control-plane handlers (saas-agents AG6). A session is a hosted
// run of the orun runtime; state is an infrastructure fact (never a work rung).
// The runtime advances state through advanceSession; the sealed
// AgentSessionSnapshot in orun's object graph is the system of record.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import { AgentsError, type RunKind, type SessionState } from "@saas/db/agents";
import { errorResponse, listResponse, notFound, successResponse, validationError } from "../http.js";
import { toPublicSession } from "../mappers.js";

const RUN_KINDS: readonly string[] = ["design", "implementation", "interactive", "fix"];

export async function handleListSessions(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.session.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const rows = await deps.repo.listSessions(
    { orgId },
    state ? { state: state as SessionState } : undefined,
  );
  return listResponse(rows.map(toPublicSession), requestId, null);
}

export async function handleGetSession(
  deps: AgentsDeps,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.session.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const s = await deps.repo.getSession({ orgId }, sessionId);
  if (!s) return notFound(requestId, sessionId);
  return successResponse(toPublicSession(s), requestId);
}

export async function handleCreateSession(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.session.create", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["invalid JSON"] });
  }
  const b = body as Record<string, unknown>;
  const missing: Record<string, string[]> = {};
  if (typeof b.profileId !== "string" || !b.profileId) missing.profileId = ["required"];
  if (typeof b.runKind !== "string" || !RUN_KINDS.includes(b.runKind)) {
    missing.runKind = [`one of ${RUN_KINDS.join(", ")}`];
  }
  if (Object.keys(missing).length > 0) return validationError(requestId, missing);

  try {
    const session = await deps.repo.createSession(
      { orgId },
      {
        profileId: b.profileId as string,
        runKind: b.runKind as RunKind,
        spawnedBy: actor.subjectId,
        ...(typeof b.workRef === "string" ? { workRef: b.workRef } : {}),
        ...(typeof b.taskKey === "string" ? { taskKey: b.taskKey } : {}),
      },
    );
    return successResponse(toPublicSession(session), requestId, 201);
  } catch (e) {
    if (e instanceof AgentsError) {
      const status = e.code === "agent_profile_not_found" ? 404 : 400;
      return errorResponse(e.code, e.message, status, requestId);
    }
    throw e;
  }
}
