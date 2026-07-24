// Origin derivation at the AG9 door (saas-agent-supervision SV0, design §2).
//
// Origin is stamped ONCE, here, from what the door authentically knows about
// the caller — never copied wholesale from a request body (a body cannot claim
// a provenance it does not hold). The door never reads a field named `origin`;
// the only body hint it honours is the narrow dispatch discriminator below.
//
// The one genuinely ambiguous case: a Work-surface dispatch and a Workspace-
// Agent (dispatcher-thread) dispatch both arrive at POST /agents/dispatch with
// the same owner credential and the same {taskKey} body — the door cannot tell
// them apart structurally. So chat-worker's session_spawn stamps an explicit
// `dispatchRef` (its thread `ch_…`); its presence is what distinguishes a
// dispatch origin from a work origin. This is a first-party hint, and origin
// carries NO authority (nothing downstream gates on it — risks R8), so a
// mislabelled dispatch-vs-work is a cosmetic lie at worst; the provenances that
// WOULD matter (session/routine/human) stay door-authoritative and unforgeable
// via the body.

import type { AgentOrigin } from "@saas/db/agents";

/** Read a non-empty string field off a parsed JSON body, else undefined. */
function str(b: Record<string, unknown>, key: string): string | undefined {
  const v = b[key];
  return typeof v === "string" && v ? v : undefined;
}

/**
 * The origin of a POST /agents/dispatch task spawn. `dispatchRef` present ⇒ a
 * dispatcher thread rang the door (dispatch); absent ⇒ a Work surface (work).
 * The work ref is the task key — the stable, public work pointer chips render.
 */
export function dispatchTaskOrigin(
  body: Record<string, unknown>,
  taskKey: string,
): AgentOrigin {
  const dispatchRef = str(body, "dispatchRef");
  if (dispatchRef) {
    const label = str(body, "dispatchLabel");
    return { kind: "dispatch", ref: dispatchRef, ...(label ? { label } : {}) };
  }
  return { kind: "work", ref: taskKey, label: taskKey };
}

/** The origin of a routine firing — door-authoritative (the routine row is the
 * standing authorization). */
export function routineOrigin(routinePublicId: string, routineName: string): AgentOrigin {
  return { kind: "routine", ref: routinePublicId, label: routineName };
}

/**
 * The origin of a POST /agents/sessions create. An agent-session bearer (the
 * runtime's agent_spawn re-entering the door — api-edge is the only thing that
 * sets x-actor-agent-session-id) is a `session` origin pointing at the parent;
 * everyone else is a direct `human` spawn. A body `origin` field is never read.
 */
export function createSessionOrigin(parentSessionId: string | undefined): AgentOrigin {
  if (parentSessionId) return { kind: "session", ref: parentSessionId };
  return { kind: "human" };
}
