// Runtime dial-home routes (saas-agents AG6 §3–4): the in-sandbox
// `orun agent serve` reaches these THROUGH api-edge with its agent-session
// token. resolve-bearer resolves that token to the profile's service
// principal with the session id surfaced; the gate here binds all three —
// the actor must BE the session's principal, presenting a token minted for
// THIS session. There is no other writer: humans read sessions, the runtime
// advances them.
//
//   POST /sessions/{id}/heartbeat — extend the lease; first beat flips
//     provisioning → running (the infrastructure fact "the runtime is up").
//   POST /sessions/{id}/events    — ingest relay events (idempotent on seq,
//     closed vocabulary — the AG5 schema rules hold at this door too).
//   POST /sessions/{id}/token     — lease-gated refresh: a live session gets
//     its next short-TTL bearer; a lapsed lease or terminal state refuses,
//     which is exactly how a kill or a runaway dies within one TTL.

import type { AgentsDeps } from "../deps.js";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { AgentSession } from "@saas/db/agents";
import { AgentsError, isTerminal } from "@saas/db/agents";
import { envelopeCrossings } from "../budget.js";
import { relayStubFor } from "../relay-epoch.js";
import { eventFrame } from "@saas/contracts/agents-attach";
import { errorResponse, notFound, successResponse, validationError } from "../http.js";
import { toPublicSession } from "../mappers.js";
import { uuidToHex } from "@saas/db/ids";

/** The token's orgId claim is the public `org_<hex>` id (matching provision),
 * so a refreshed credential is indistinguishable from the first mint. */
function orgPublicId(orgUuid: string): string {
  return `org_${uuidToHex(orgUuid)}`;
}

/** Lease horizon per heartbeat/refresh (design §3.2: ~15 min TTL chain). */
export const LEASE_TTL_MS = 15 * 60 * 1000;

interface SessionGate {
  session: AgentSession;
}

/**
 * The session-actor gate: service principal + principal match + session-bound
 * token. Returns a Response (the refusal) or the session.
 */
export async function gateSessionActor(
  deps: AgentsDeps,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<SessionGate | Response> {
  const session = await deps.repo.getSession({ orgId }, sessionId);
  if (!session) return notFound(requestId, sessionId);
  if (actor.subjectType !== "service_principal" || actor.agentSessionId !== session.publicId) {
    return errorResponse("forbidden", "Not this session's credential", 403, requestId);
  }
  const profile = await deps.repo.getSessionProfile({ orgId }, sessionId);
  if (!profile || profile.principalId !== actor.subjectId) {
    return errorResponse("forbidden", "Not this session's principal", 403, requestId);
  }
  return { session };
}

export async function handleSessionHeartbeat(
  deps: AgentsDeps,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<Response> {
  const gate = await gateSessionActor(deps, orgId, sessionId, actor, requestId);
  if (gate instanceof Response) return gate;
  const { session } = gate;

  const lease = new Date(now().getTime() + LEASE_TTL_MS).toISOString();
  try {
    if (session.state === "provisioning") {
      const updated = await deps.repo.advanceSession(
        { orgId },
        { publicId: session.publicId, to: "running", leaseExpiresAt: lease },
      );
      // The dial-home succeeded: the in-sandbox runtime reached this door and
      // the box is live. This is the positive counterpart to the provision
      // trace + the sweep's `never_booted` reclaim — it's how you see a boot
      // finally cross the line (matching the `[agents-…]` log style).
      console.warn(
        `[agents-runtime] session=${session.publicId} org=${orgPublicId(orgId)} step=running (first heartbeat)`,
      );
      return successResponse(toPublicSession(updated), requestId);
    }
    const updated = await deps.repo.touchSessionLease({ orgId }, session.publicId, lease);
    return successResponse(toPublicSession(updated), requestId);
  } catch (e) {
    if (e instanceof AgentsError) {
      return errorResponse(e.code, e.message, 409, requestId);
    }
    throw e;
  }
}

export async function handleIngestSessionEvent(
  request: Request,
  deps: AgentsDeps,
  orgId: string,
  env: Env | undefined,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  const gate = await gateSessionActor(deps, orgId, sessionId, actor, requestId);
  if (gate instanceof Response) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["invalid JSON"] });
  }
  // Accept one event or a batch — the relay flushes in small batches.
  const events = Array.isArray(body) ? body : [body];
  if (events.length === 0 || events.length > 100) {
    return validationError(requestId, { body: ["1–100 events per call"] });
  }
  try {
    for (const raw of events) {
      const e = raw as Record<string, unknown>;
      if (typeof e.seq !== "number" || typeof e.kind !== "string") {
        return validationError(requestId, { events: ["each event needs seq (number) + kind"] });
      }
      await deps.repo.appendSessionEvent(
        { orgId },
        {
          sessionPublicId: sessionId,
          seq: e.seq,
          kind: e.kind as never,
          ...(typeof e.payload === "object" && e.payload !== null
            ? { payload: e.payload as Record<string, unknown> }
            : {}),
          ...(typeof e.ref === "string" ? { ref: e.ref } : {}),
        },
      );
    }
  } catch (e) {
    if (e instanceof AgentsError) {
      return errorResponse(e.code, e.message, 422, requestId);
    }
    throw e;
  }

  // Live-tail mirror (saas-agents-native AN1, closing the AL6 remainder):
  // the durable batch fans out to the session's relay DO as attach-v1 event
  // frames, so attached heads see events the moment they land — the DB write
  // above stays the system of record; the DO ingest dedupes by seq. Best
  // effort: a mirror failure never fails an ingest (the console still reads
  // the DB; a head re-attach replays from the mirror's next success).
  try {
    const stub = env ? relayStubFor(env, sessionId, gate.session.createdAt) : null;
    if (stub) {
      const frames = events.map((raw) => {
        const e = raw as Record<string, unknown>;
        return eventFrame(
          e.seq as number,
          e.kind as string,
          typeof e.at === "string" ? e.at : "",
          typeof e.payload === "object" && e.payload !== null ? (e.payload as Record<string, unknown>) : undefined,
          typeof e.ref === "string" ? e.ref : undefined,
        );
      });
      await stub.fetch(
        new Request("https://relay/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(frames),
        }),
      );
    }
  } catch {
    // Mirror is a projection; the sealed log already has the events.
  }

  // Metering (saas-agents-live AL9, closing AG10's remainder): tokens from
  // cost samples, minutes on the terminal transition. Fire-and-forget — a
  // lost sample is a reconciliation problem, never a failed ingest.
  emitMetering(deps, orgId, gate.session, events, actor, requestId);

  // Budget accumulation + the graceful interrupt (AF8 §7): spend lands on
  // the session row; crossing an envelope enqueues ONE interrupt on the DO
  // return queue — the runtime finishes its current tool call and seals a
  // budget_exhausted terminal, never a hard kill. Best-effort like metering.
  try {
    let delta = 0;
    for (const raw of events) {
      const e = raw as Record<string, unknown>;
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      if (e.kind === "cost_sample" && typeof payload.tokens === "number" && payload.tokens > 0) {
        delta += payload.tokens;
      }
    }
    if (delta > 0) {
      const prev = gate.session.tokensUsed;
      const updated = await deps.repo.addSessionTokens({ orgId }, sessionId, delta);
      const [budgets, sessions] = await Promise.all([
        deps.repo.listBudgets({ orgId }),
        deps.repo.listSessions({ orgId }),
      ]);
      const crossing = envelopeCrossings(budgets, sessions, updated, prev);
      const bstub = crossing && env ? relayStubFor(env, sessionId, gate.session.createdAt) : null;
      if (crossing && bstub) {
        await bstub.fetch(
          new Request("https://relay/input", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-actor-principal": "agents-worker-budget",
            },
            body: JSON.stringify({
              v: 1,
              t: "interrupt",
              ref: `budget-${sessionId}-${crossing.grain}`,
              reason: `budget_exhausted: ${crossing.grain} ceiling ${crossing.limit} tokens (used ${crossing.used})`,
            }),
          }),
        );
      }
    }
  } catch {
    // A budget bookkeeping failure never fails an ingest; the sweep and the
    // attention fold still see the spend on the next batch.
  }

  return successResponse({ accepted: events.length }, requestId);
}

/**
 * emitMetering derives the runtime usage meters from a relayed event batch:
 * `agents.tokens` (summed over cost_sample events with a numeric `tokens`
 * payload) and `agents.session_minutes` (the lease bracket startedAt→now, on
 * the terminal state_changed). Never throws; never blocks the ingest.
 */
function emitMetering(
  deps: AgentsDeps,
  orgId: string,
  session: AgentSession,
  events: unknown[],
  actor: ActorContext,
  requestId: string,
): void {
  if (!deps.usage) return;
  const dims = { runKind: session.runKind };

  let tokens = 0;
  let terminal = false;
  for (const raw of events) {
    const e = raw as Record<string, unknown>;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === "cost_sample" && typeof payload.tokens === "number") {
      tokens += payload.tokens;
    }
    if (e.kind === "state_changed" && typeof payload.state === "string" && isTerminal(payload.state as never)) {
      terminal = true;
    }
  }

  if (tokens > 0) {
    void deps.usage.record(orgId, "agents.tokens", tokens, dims, actor, requestId);
  }
  if (terminal && session.startedAt) {
    const minutes = Math.max(1, Math.ceil((Date.now() - new Date(session.startedAt).getTime()) / 60_000));
    void deps.usage.record(orgId, "agents.session_minutes", minutes, dims, actor, requestId);
  }
}

export async function handleRefreshSessionToken(
  deps: AgentsDeps,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
  now: () => Date = () => new Date(),
): Promise<Response> {
  const gate = await gateSessionActor(deps, orgId, sessionId, actor, requestId);
  if (gate instanceof Response) return gate;
  const { session } = gate;

  // The lease IS the refresh gate (design §3.2): terminal or lapsed → the
  // chain dies; kill works by never extending it.
  if (isTerminal(session.state)) {
    return errorResponse("conflict", `Session is ${session.state}`, 409, requestId);
  }
  if (!session.leaseExpiresAt || new Date(session.leaseExpiresAt).getTime() <= now().getTime()) {
    return errorResponse("forbidden", "Session lease has lapsed", 403, requestId);
  }
  if (!deps.sessionTokens) {
    return errorResponse("internal_error", "Token service unavailable", 503, requestId);
  }
  const minted = await deps.sessionTokens.mint(actor.subjectId, orgPublicId(orgId), session.publicId, requestId);
  if (!minted) {
    return errorResponse("internal_error", "Token mint failed", 502, requestId);
  }
  return successResponse(minted, requestId, 201);
}
