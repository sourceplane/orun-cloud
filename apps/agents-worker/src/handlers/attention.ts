// The attention plane (saas-agents-fleet AF5, design §4) — the needs-you
// fold. A pure computed read over facts already stored: session states, lease
// health, and (from AF6/AF8) routine parks and budget marks. Nothing here is
// written anywhere — there is no inbox row to go stale and no dismiss verb;
// acting on an item (a verdict, a re-dispatch, a kill) removes it by making
// its source fact false.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import type { AgentSession, Routine, SessionEvent } from "@saas/db/agents";
import type { AttentionItem, AttentionKind, AttentionSummary } from "@saas/contracts/agents";
import { ATTENTION_RANK, ATTENTION_KINDS } from "@saas/contracts/agents";
import { errorResponse, successResponse } from "../http.js";

/** A failed task-bound session older than this stops offering a re-dispatch —
 * stale failures belong to the digest, not the queue. */
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The latest approval_requested with no later approval_resolved for the same
 * requestId — the pending ask a verdict item surfaces. */
export function pendingApproval(events: SessionEvent[]): { requestId: string; tool: string; at: string } | null {
  const resolved = new Set<string>();
  for (const e of events) {
    if (e.kind === "approval_resolved") resolved.add(str(e.payload.requestId));
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "approval_requested") continue;
    const requestId = str(e.payload.requestId);
    if (requestId && resolved.has(requestId)) continue;
    return { requestId, tool: str(e.payload.tool), at: e.at };
  }
  return null;
}

function provenance(s: AgentSession): Pick<AttentionItem, "profileId" | "runKind" | "state" | "workRef" | "taskKey"> {
  return {
    profileId: s.profileId,
    runKind: s.runKind,
    state: s.state,
    ...(s.workRef !== undefined ? { workRef: s.workRef } : {}),
    ...(s.taskKey !== undefined ? { taskKey: s.taskKey } : {}),
  };
}

/**
 * foldAttention computes the needs-you queue from the workspace's sessions
 * (+ each awaiting session's relayed events, for the answerable ask). Pure —
 * the handler supplies rows and a clock, tests drive it directly.
 */
export function foldAttention(
  sessions: AgentSession[],
  eventsBySession: Map<string, SessionEvent[]>,
  now: Date,
  routines: Routine[] = [],
): AttentionSummary {
  const items: AttentionItem[] = [];
  const t = now.getTime();

  // Parked routines (AF6): the standing order stopped standing — a human
  // must resume it. Acting (resume/disable/delete) removes the item.
  for (const r of routines) {
    if (!r.parked) continue;
    items.push({
      kind: "routine_parked",
      routineId: r.publicId,
      reason: r.parkedReason ?? "parked after repeated failures",
      at: r.updatedAt,
    });
  }

  for (const s of sessions) {
    if (s.state === "awaiting_approval") {
      const ask = pendingApproval(eventsBySession.get(s.publicId) ?? []);
      items.push({
        kind: "verdict",
        sessionId: s.publicId,
        ...provenance(s),
        reason: ask?.tool ? `wants to run ${ask.tool}` : "waiting on your verdict",
        at: ask?.at ?? s.createdAt,
        ...(ask?.requestId ? { request: { requestId: ask.requestId, tool: ask.tool } } : {}),
      });
      continue;
    }
    if (s.state === "running" && s.leaseExpiresAt && Date.parse(s.leaseExpiresAt) < t) {
      items.push({
        kind: "stuck",
        sessionId: s.publicId,
        ...provenance(s),
        reason: "no heartbeat — lease lapsed, sweep pending",
        at: s.leaseExpiresAt,
      });
      continue;
    }
    if (
      s.state === "failed" &&
      s.taskKey &&
      s.endedAt &&
      t - Date.parse(s.endedAt) < RETRY_WINDOW_MS
    ) {
      const failure = str(s.sandbox.error);
      items.push({
        kind: "failed_retryable",
        sessionId: s.publicId,
        ...provenance(s),
        reason: failure ? `failed (${failure}) — re-dispatch available` : "failed — re-dispatch available",
        at: s.endedAt,
      });
    }
  }

  items.sort((a, b) => ATTENTION_RANK[a.kind] - ATTENTION_RANK[b.kind] || a.at.localeCompare(b.at));

  const counts = Object.fromEntries(ATTENTION_KINDS.map((k) => [k, 0])) as Record<AttentionKind, number>;
  for (const item of items) counts[item.kind] += 1;

  return {
    items,
    counts,
    running: sessions.filter((s) => s.state === "running").length,
  };
}

/** GET …/agents/attention — read-gated like the fleet view it feeds. */
export async function handleGetAttention(
  deps: AgentsDeps,
  orgId: string,
  actor: ActorContext,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.session.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const scope = { orgId };
  const sessions = await deps.repo.listSessions(scope);
  const routines = await deps.repo.listRoutines(scope);
  // Only awaiting sessions need their events (for the answerable ask); the
  // fleet rarely holds more than a handful at once.
  const eventsBySession = new Map<string, SessionEvent[]>();
  for (const s of sessions) {
    if (s.state !== "awaiting_approval") continue;
    eventsBySession.set(s.publicId, await deps.repo.listSessionEvents(scope, s.publicId));
  }
  return successResponse(foldAttention(sessions, eventsBySession, now(), routines), requestId);
}
