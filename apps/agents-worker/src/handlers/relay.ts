// Relay route handlers (saas-agents-live AL6): the thin HTTP layer that
// authorizes and forwards to the per-session Durable Object (relay-do.ts).
// Two audiences:
//
//   Head-facing (console, remote `orun agent attach as_…`):
//     GET  …/sessions/{id}/attach   SSE feed  — needs agent.session.read
//     POST …/sessions/{id}/input    one input — needs agent.session.interact
//
//   Body-facing (the in-sandbox `orun agent serve`, three-way session gate):
//     POST …/sessions/{id}/stream      wire-only delta fan-out (never stored)
//     GET  …/sessions/{id}/inputs       the input return-queue long-poll
//     POST …/sessions/{id}/inputs/ack   ack a head input
//
// Durable event ingest is the shared POST …/sessions/{id}/events route
// (runtime.ts): it writes the log the console reads AND is the natural place to
// mirror to the DO for live tail. The relay here carries only the live wire —
// deltas + the steer return-queue. The DO is the wire; this layer never
// inspects agent semantics.

import type { Env } from "../env.js";
import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import { errorResponse } from "../http.js";
import { gateSessionActor } from "./runtime.js";

/** relayStub resolves the per-session DO instance, or null when unbound. */
function relayStub(env: Env, sessionId: string): DurableObjectStub | null {
  if (!env.SESSION_RELAY) return null;
  const id = env.SESSION_RELAY.idFromName(sessionId);
  return env.SESSION_RELAY.get(id);
}

/** forward maps a worker request to the DO's internal HTTP surface. */
async function forward(
  stub: DurableObjectStub,
  method: string,
  path: string,
  init?: { body?: string; headers?: Record<string, string> },
): Promise<Response> {
  const reqInit: RequestInit = { method };
  if (init?.body !== undefined) reqInit.body = init.body;
  if (init?.headers !== undefined) reqInit.headers = init.headers;
  return stub.fetch(new Request(`https://relay${path}`, reqInit));
}

// ── Head-facing ─────────────────────────────────────────────

/** GET …/attach — the console/remote head SSE feed. Requires read. */
export async function handleAttach(
  env: Env,
  deps: AgentsDeps,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
  from: number,
  surface: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.session.read", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const stub = relayStub(env, sessionId);
  if (!stub) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  const principal = actor.subjectId || "unknown";
  return forward(
    stub,
    "GET",
    `/attach?from=${from}&surface=${encodeURIComponent(surface)}&principal=${encodeURIComponent(principal)}`,
  );
}

/** POST …/input — a head steer/verdict/interrupt/end. Requires interact; the
 * principal is stamped from the resolved actor, never the body. */
export async function handleHeadInput(
  request: Request,
  env: Env,
  deps: AgentsDeps,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.session.interact", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const stub = relayStub(env, sessionId);
  if (!stub) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  const body = await request.text();
  return forward(stub, "POST", "/input", {
    body,
    headers: {
      "content-type": "application/json",
      "x-actor-principal": actor.subjectId || "unknown",
    },
  });
}

// ── Body-facing (the in-sandbox runtime) ────────────────────
// Same three-way session gate as heartbeat/events (runtime.ts): the caller must
// BE this session's service principal, presenting a token minted for THIS
// session. The relay carries the run's own log/steer traffic — it is exactly as
// sensitive as the event ingest, so it gates identically. Without this a leaked
// session id would let any principal read the input queue or inject deltas.

export async function handleRelayStream(
  request: Request,
  deps: AgentsDeps,
  env: Env,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  const gate = await gateSessionActor(deps, orgId, sessionId, actor, requestId);
  if (gate instanceof Response) return gate;
  const stub = relayStub(env, sessionId);
  if (!stub) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  return forward(stub, "POST", "/stream", {
    body: await request.text(),
    headers: { "content-type": "application/json" },
  });
}

export async function handleRelayPollInputs(
  deps: AgentsDeps,
  env: Env,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
  cursor: number,
): Promise<Response> {
  const gate = await gateSessionActor(deps, orgId, sessionId, actor, requestId);
  if (gate instanceof Response) return gate;
  const stub = relayStub(env, sessionId);
  if (!stub) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  return forward(stub, "GET", `/inputs?cursor=${cursor}`);
}

export async function handleRelayAck(
  request: Request,
  deps: AgentsDeps,
  env: Env,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  const gate = await gateSessionActor(deps, orgId, sessionId, actor, requestId);
  if (gate instanceof Response) return gate;
  const stub = relayStub(env, sessionId);
  if (!stub) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  return forward(stub, "POST", "/inputs/ack", {
    body: await request.text(),
    headers: { "content-type": "application/json" },
  });
}
