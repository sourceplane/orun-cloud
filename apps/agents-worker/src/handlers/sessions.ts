// Agent-session control-plane handlers (saas-agents AG6). A session is a hosted
// run of the orun runtime; state is an infrastructure fact (never a work rung).
// The runtime advances state through advanceSession; the sealed
// AgentSessionSnapshot in orun's object graph is the system of record.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import { AgentsError, type AgentSession as DbSession, type RunKind, type SessionState } from "@saas/db/agents";
import {
  ceilingOf,
  intersectCeiling,
  DELEGATION_ERROR_CODES,
  TREE_LIMITS,
} from "@saas/contracts/agents";
import { errorResponse, listResponse, notFound, successResponse, validationError } from "../http.js";
import { toPublicSession } from "../mappers.js";

const RUN_KINDS: readonly string[] = ["design", "implementation", "interactive", "fix"];

/** States a parent may spawn from / that count against width caps. */
const LIVE_STATES: readonly string[] = ["requested", "provisioning", "running", "awaiting_approval"];

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

/**
 * The spawn-door gate stack (saas-agents-fleet AF4, design §3.1). Runs ONLY
 * when the caller is an agent session (`agent_spawn` re-entering the public
 * API with its session token); the parent is the caller's own session — a
 * body-supplied parent is unrepresentable. Pure set math and counters, no
 * policy evaluation. Returns the gate refusal, or the create-input extras
 * (parent linkage + applied ceiling) on pass.
 */
async function evaluateSpawnGates(
  deps: AgentsDeps,
  orgId: string,
  parentPublicId: string,
  childProfileId: string,
  requestId: string,
): Promise<
  | { refusal: Response }
  | { parentSessionId: string; sandbox: Record<string, unknown> }
> {
  const scope = { orgId };
  const parent = await deps.repo.getSession(scope, parentPublicId);
  if (!parent) {
    return { refusal: errorResponse("agent_session_not_found", "Spawning session not found", 404, requestId) };
  }
  if (!LIVE_STATES.includes(parent.state)) {
    return {
      refusal: errorResponse(
        DELEGATION_ERROR_CODES.parentNotLive,
        `Parent session is ${parent.state}; only a live session may spawn`,
        409,
        requestId,
      ),
    };
  }
  // Depth: the child would sit at parent.depth + 1.
  if (parent.depth + 1 > TREE_LIMITS.maxDepth) {
    return {
      refusal: errorResponse(
        DELEGATION_ERROR_CODES.treeDepthExceeded,
        `Tree depth cap is ${TREE_LIMITS.maxDepth}; parent is already at depth ${parent.depth}`,
        409,
        requestId,
      ),
    };
  }
  // Width: live children of this parent, live nodes of the whole tree.
  const sessions = await deps.repo.listSessions(scope);
  const live = (s: DbSession) => LIVE_STATES.includes(s.state);
  const liveChildren = sessions.filter((s) => s.parentSessionId === parent.publicId && live(s)).length;
  if (liveChildren >= TREE_LIMITS.maxLiveChildrenPerParent) {
    return {
      refusal: errorResponse(
        DELEGATION_ERROR_CODES.treeWidthExceeded,
        `Parent already has ${liveChildren} live children (cap ${TREE_LIMITS.maxLiveChildrenPerParent})`,
        409,
        requestId,
      ),
    };
  }
  const liveTree = sessions.filter((s) => s.rootSessionId === parent.rootSessionId && live(s)).length;
  if (liveTree >= TREE_LIMITS.maxLiveNodesPerTree) {
    return {
      refusal: errorResponse(
        DELEGATION_ERROR_CODES.treeWidthExceeded,
        `Tree already has ${liveTree} live sessions (cap ${TREE_LIMITS.maxLiveNodesPerTree})`,
        409,
        requestId,
      ),
    };
  }
  // The ceiling only narrows: child effective = parent effective ∩ child
  // profile. The parent's own applied ceiling (if it is itself a child)
  // composes down — intersection is associative.
  const parentProfile = await deps.repo.getSessionProfile(scope, parent.publicId);
  const childProfile =
    (await deps.repo.listProfiles(scope)).find(
      (p) => p.publicId === childProfileId || p.id === childProfileId,
    ) ?? null;
  const parentApplied = ceilingOf(
    (parent.sandbox.appliedCeiling as Record<string, unknown> | undefined) ??
      parentProfile?.capability,
  );
  const applied = intersectCeiling(parentApplied, ceilingOf(childProfile?.capability));
  return {
    parentSessionId: parent.publicId,
    // The applied ceiling is an infrastructure fact on the child; the runtime
    // additionally seals it into both session logs (orun AF0).
    sandbox: { appliedCeiling: applied as unknown as Record<string, unknown> },
  };
}

export async function handleCreateSession(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  // An agent-session bearer is the runtime's agent_spawn re-entering the
  // public API: it needs the SPAWN grant (deny-by-default, distinct from
  // create — F-Q1) and passes the tree gates. Everyone else is the existing
  // human/service create path, unchanged.
  const isAgentSpawn = !!actor.agentSessionId;
  const action = isAgentSpawn ? "organization.agent.session.spawn" : "organization.agent.session.create";
  if (!(await deps.authorize(action, orgId, actor, requestId))) {
    return errorResponse(
      isAgentSpawn ? DELEGATION_ERROR_CODES.spawnNotAllowed : "forbidden",
      "Not authorized",
      403,
      requestId,
    );
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

  let spawnExtras: { parentSessionId: string; sandbox: Record<string, unknown> } | undefined;
  if (isAgentSpawn) {
    const gate = await evaluateSpawnGates(deps, orgId, actor.agentSessionId!, b.profileId as string, requestId);
    if ("refusal" in gate) return gate.refusal;
    spawnExtras = gate;
  }

  try {
    const session = await deps.repo.createSession(
      { orgId },
      {
        profileId: b.profileId as string,
        runKind: b.runKind as RunKind,
        spawnedBy: actor.subjectId,
        ...(typeof b.workRef === "string" ? { workRef: b.workRef } : {}),
        ...(typeof b.taskKey === "string" ? { taskKey: b.taskKey } : {}),
        ...(spawnExtras ?? {}),
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
