// The roster fold (saas-agent-supervision SV1, design §7.2): "this thread's
// implementers" as a per-viewer fold over sessions by origin + live state —
// never a stored second truth. The implementers whose origin is
// {kind:"dispatch", ref:<thread ch_…>}, split active/terminal, each active one
// joined with the AF6 needs-you fact and its delegation tier. `session.read`-
// gated, viewer-credentialed (the same discipline as the attention plane it
// borrows from).

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import type { AgentSession as DbSession, SessionEvent } from "@saas/db/agents";
import { isTerminal } from "@saas/db/agents";
import type {
  AttentionItem,
  ChatImplementers,
  DelegationInterface,
  RosterImplementer,
} from "@saas/contracts/agents";
import { toPublicSession } from "../mappers.js";
import { foldAttention } from "./attention.js";
import { errorResponse, successResponse } from "../http.js";

/**
 * foldChatImplementers — the pure fold. Given the workspace's sessions, a
 * profile→interface map (the DD10 tier), and the per-session needs-you facts,
 * produce a thread's roster. Newest active first; terminal ones fold to a
 * single `done` count (they live on the Implementers surface, not here).
 */
export function foldChatImplementers(
  chatId: string,
  sessions: DbSession[],
  interfaceByProfileId: Map<string, DelegationInterface>,
  attentionBySessionId: Map<string, AttentionItem>,
): ChatImplementers {
  const mine = sessions.filter((s) => s.origin.kind === "dispatch" && s.origin.ref === chatId);
  const activeRows = mine
    .filter((s) => !isTerminal(s.state))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const done = mine.length - activeRows.length;

  const active: RosterImplementer[] = activeRows.map((s) => {
    const entry: RosterImplementer = {
      session: toPublicSession(s),
      interface: interfaceByProfileId.get(s.profileId) ?? "orun-sandbox",
    };
    const needs = attentionBySessionId.get(s.publicId);
    if (needs) entry.needsYou = needs;
    return entry;
  });

  return {
    chatId,
    active,
    running: active.filter((a) => a.session.state === "running").length,
    needsYou: active.filter((a) => a.needsYou !== undefined).length,
    done,
  };
}

/** GET …/agents/chats/:chatId/implementers — the roster the thread's side
 * panel renders, read-gated like the fleet view it complements. */
export async function handleChatImplementers(
  deps: AgentsDeps,
  orgId: string,
  chatId: string,
  actor: ActorContext,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.session.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const scope = { orgId };
  const sessions = await deps.repo.listSessions(scope);
  const mine = sessions.filter((s) => s.origin.kind === "dispatch" && s.origin.ref === chatId);

  // Needs-you per implementer: reuse the attention fold over just THIS thread's
  // sessions (verdict / stuck / failed_retryable are all per-session facts;
  // budget/routine items aren't per-implementer, so routines/budgets stay
  // empty). Only awaiting sessions need their events for the answerable ask.
  const eventsBySession = new Map<string, SessionEvent[]>();
  for (const s of mine) {
    if (s.state !== "awaiting_approval") continue;
    eventsBySession.set(s.publicId, await deps.repo.listSessionEvents(scope, s.publicId));
  }
  const attention = foldAttention(mine, eventsBySession, now());
  const attentionBySessionId = new Map<string, AttentionItem>();
  for (const item of attention.items) {
    // Items are rank-sorted; keep the highest-priority one per session.
    if (item.sessionId && !attentionBySessionId.has(item.sessionId)) {
      attentionBySessionId.set(item.sessionId, item);
    }
  }

  const profiles = await deps.repo.listProfiles(scope);
  const interfaceByProfileId = new Map<string, DelegationInterface>(
    profiles.map((p) => [p.id, p.interface]),
  );

  return successResponse(
    foldChatImplementers(chatId, sessions, interfaceByProfileId, attentionBySessionId),
    requestId,
  );
}
