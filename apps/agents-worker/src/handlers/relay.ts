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
import { relayPeerFor, relayStubFor } from "../relay-epoch.js";

/** relayStub resolves the per-session DO instance, or null when unbound. */
function relayStub(env: Env, sessionId: string): DurableObjectStub | null {
  return relayStubFor(env, sessionId);
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

/** GET …/attach — the console/remote head feed: a WebSocket when the client
 * asks to upgrade (saas-agents-native AN1 — the SDK relay's socket, attach-v1
 * frames both directions), the AL6 SSE stream otherwise. Requires read. The
 * upgrade is forwarded through the stub untouched; the attach params +
 * edge-stamped principal ride the forwarded URL exactly as SSE's do. */
export async function handleAttach(
  request: Request,
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
  const session = await deps.repo.getSession({ orgId }, sessionId);
  if (!session) return errorResponse("not_found", "Session not found", 404, requestId);
  const stub = relayStub(env, sessionId);
  if (!stub) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  const principal = actor.subjectId || "unknown";
  const qs = `from=${from}&surface=${encodeURIComponent(surface)}&principal=${encodeURIComponent(principal)}`;

  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    // WS binding: the SDK relay speaks attach-v1 frames both directions. The
    // upgrade is forwarded through the stub untouched.
    return stub.fetch(new Request(`https://relay/attach?${qs}`, request));
  }

  return forward(stub, "GET", `/attach?${qs}`);
}

/** GET …/agui/watch — the session AG-UI watch door (saas-copilot-surface
 * CX1, design §2.3): the attach feed through the bridge. Same read gate,
 * same choreography (hello → replay → live), a second dialect on the wire. */
export async function handleAguiWatch(
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
  const session = await deps.repo.getSession({ orgId }, sessionId);
  if (!session) return errorResponse("not_found", "Session not found", 404, requestId);
  const stub = relayStub(env, sessionId);
  if (!stub) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  const principal = actor.subjectId || "unknown";
  const qs = `from=${from}&surface=${encodeURIComponent(surface)}&principal=${encodeURIComponent(principal)}&sessionId=${encodeURIComponent(sessionId)}`;
  return forward(stub, "GET", `/agui-watch?${qs}`);
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
  const session = await deps.repo.getSession({ orgId }, sessionId);
  if (!session) return errorResponse("not_found", "Session not found", 404, requestId);
  const peer = relayPeerFor(env, sessionId);
  if (!peer) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  const principal = actor.subjectId || "unknown";
  const frame = (await request.json()) as Record<string, unknown>;
  return Response.json(await peer.rpc.headInput(frame, principal));
}

/** POST …/control — take or return the wheel (SV5). Requires interact; the
 * holding principal is the resolved actor, never the body. */
export async function handleControl(
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
  const session = await deps.repo.getSession({ orgId }, sessionId);
  if (!session) return errorResponse("not_found", "Session not found", 404, requestId);
  const body = (await request.json().catch(() => ({}))) as { action?: string };
  const action = body.action === "take" || body.action === "return" ? body.action : undefined;
  if (!action) return errorResponse("validation_failed", "action must be take|return", 422, requestId);
  const peer = relayPeerFor(env, sessionId);
  if (!peer) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  const principal = actor.subjectId || "unknown";
  return Response.json(await peer.rpc.control(action, principal));
}

// ── Body-facing (the in-sandbox runtime) ────────────────────
// Same three-way session gate as heartbeat/events (runtime.ts): the caller must
// BE this session's service principal, presenting a token minted for THIS
// session. The relay carries the run's own log/steer traffic — it is exactly as
// sensitive as the event ingest, so it gates identically. Without this a leaked
// session id would let any principal read the input queue or inject deltas.

/** GET …/wire — the body's one-socket binding (orun AN0): head inputs pushed
 * down, acks + deltas up, attach-v1 frames throughout. Upgrade-only, gated
 * exactly like the other body routes, and only the SDK relay class speaks it
 * (a draining KV-class session keeps its long-poll — the body falls back). */
export async function handleBodyWire(
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
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse("upgrade_required", "The wire is WebSocket-only", 426, requestId);
  }
  const stub = relayStub(env, sessionId);
  if (!stub) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  return stub.fetch(new Request("https://relay/wire", request));
}

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
  const peer = relayPeerFor(env, sessionId);
  if (!peer) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  await peer.rpc.streamDelta(await request.json());
  return Response.json({ ok: true });
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
  const peer = relayPeerFor(env, sessionId);
  if (!peer) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  return Response.json(await peer.rpc.pollInputs(cursor));
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
  const peer = relayPeerFor(env, sessionId);
  if (!peer) return errorResponse("unavailable", "Relay not configured", 503, requestId);
  await peer.rpc.ackInput(await request.json());
  return Response.json({ ok: true });
}
