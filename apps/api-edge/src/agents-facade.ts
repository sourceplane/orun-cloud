import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";

// Agents control plane (saas-agents AG6). Workspace(org)-scoped: profiles, the
// session collection + item, and the session-event relay read. api-edge resolves
// the caller, stamps x-actor-* (the worker authorizes deny-by-default from
// them), and forwards to the agents-worker service binding. Internal routes
// (/v1/internal/*) are never forwarded here — the in-sandbox runtime reaches
// the DO relay over its own session credential (a later AG6 slice).
const ORG_AGENTS_PROFILES_RE = /^\/v1\/organizations\/[^/]+\/agents\/profiles$/;
// Earned autonomy (saas-agents-fleet AF7): the profile item (autonomy PATCH,
// human-acked) and the org-wide track-record read.
const ORG_AGENTS_PROFILE_RE = /^\/v1\/organizations\/[^/]+\/agents\/profiles\/[^/]+$/;
const ORG_AGENTS_RECORDS_RE = /^\/v1\/organizations\/[^/]+\/agents\/records$/;
const ORG_AGENTS_SESSIONS_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions$/;
const ORG_AGENTS_SESSION_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+$/;
const ORG_AGENTS_SESSION_EVENTS_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/events$/;
const ORG_AGENTS_SESSION_PROVISION_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/provision$/;
// Tree-transitive kill (saas-agents-fleet AF4).
const ORG_AGENTS_SESSION_CANCEL_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/cancel$/;
// Runtime dial-home (AG6): heartbeat + lease-gated token refresh; event
// ingest rides the events route (POST). Authenticated by the agent-session
// bearer like everything else through this facade.
const ORG_AGENTS_SESSION_HEARTBEAT_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/heartbeat$/;
const ORG_AGENTS_SESSION_TOKEN_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/token$/;
// Provider connections (AG12 §10): BYO Daytona / Anthropic keys. The apiKey in
// the create body transits this facade exactly once, straight to the worker —
// never logged, never cached (idempotency stores replay by key, not body).
// Autonomy policy + the dispatch door (AG9 §7): the ladder is read/written
// here; every autonomous spawn re-enters through /agents/dispatch.
// Head-facing relay routes (saas-agents-live AL7): the SSE attach feed and the
// steer/verdict/interrupt/end input. The actor is stamped from the resolved
// bearer, so the DO/body attribute inputs to the authenticated console user.
const ORG_AGENTS_SESSION_ATTACH_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/attach$/;
const ORG_AGENTS_SESSION_INPUT_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/input$/;
// Body-facing relay routes (#466): the in-sandbox runtime's live wire — delta
// fan-out + the steer return-queue. Authenticated by the agent-session bearer
// like heartbeat/events; the worker applies the three-way session gate.
const ORG_AGENTS_SESSION_STREAM_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/stream$/;
const ORG_AGENTS_SESSION_INPUTS_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/inputs$/;
const ORG_AGENTS_SESSION_INPUTS_ACK_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/inputs\/ack$/;
// The body wire (orun-agents-native AN0): the runtime's one-socket binding,
// authenticated by the agent-session bearer like the other body routes.
const ORG_AGENTS_SESSION_WIRE_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/wire$/;
const ORG_AGENTS_AUTONOMY_RE = /^\/v1\/organizations\/[^/]+\/agents\/autonomy$/;
// The needs-you fold (saas-agents-fleet AF5): the fleet home's attention queue.
const ORG_AGENTS_ATTENTION_RE = /^\/v1\/organizations\/[^/]+\/agents\/attention$/;
// Standing routines (saas-agents-fleet AF6): registry CRUD + resume.
const ORG_AGENTS_ROUTINES_RE = /^\/v1\/organizations\/[^/]+\/agents\/routines$/;
const ORG_AGENTS_ROUTINE_RE = /^\/v1\/organizations\/[^/]+\/agents\/routines\/[^/]+$/;
// Budgets (saas-agents-fleet AF8): the ceilings registry.
const ORG_AGENTS_BUDGETS_RE = /^\/v1\/organizations\/[^/]+\/agents\/budgets$/;
const ORG_AGENTS_BUDGET_RE = /^\/v1\/organizations\/[^/]+\/agents\/budgets\/[^/]+$/;
const ORG_AGENTS_DISPATCH_RE = /^\/v1\/organizations\/[^/]+\/agents\/dispatch$/;
const ORG_AGENTS_PROVIDERS_RE = /^\/v1\/organizations\/[^/]+\/agents\/providers$/;
const ORG_AGENTS_PROVIDER_RE = /^\/v1\/organizations\/[^/]+\/agents\/providers\/[^/]+$/;
const ORG_AGENTS_PROVIDER_VERIFY_RE = /^\/v1\/organizations\/[^/]+\/agents\/providers\/[^/]+\/verify$/;

const FORWARDED_HEADERS = ["content-type", "x-request-id", "traceparent", "idempotency-key"];

export function isAgentsRoute(pathname: string): boolean {
  return (
    ORG_AGENTS_PROFILES_RE.test(pathname) ||
    ORG_AGENTS_PROFILE_RE.test(pathname) ||
    ORG_AGENTS_RECORDS_RE.test(pathname) ||
    ORG_AGENTS_SESSIONS_RE.test(pathname) ||
    ORG_AGENTS_SESSION_RE.test(pathname) ||
    ORG_AGENTS_SESSION_EVENTS_RE.test(pathname) ||
    ORG_AGENTS_SESSION_PROVISION_RE.test(pathname) ||
    ORG_AGENTS_SESSION_CANCEL_RE.test(pathname) ||
    ORG_AGENTS_SESSION_HEARTBEAT_RE.test(pathname) ||
    ORG_AGENTS_SESSION_TOKEN_RE.test(pathname) ||
    ORG_AGENTS_SESSION_ATTACH_RE.test(pathname) ||
    ORG_AGENTS_SESSION_INPUT_RE.test(pathname) ||
    ORG_AGENTS_SESSION_STREAM_RE.test(pathname) ||
    ORG_AGENTS_SESSION_INPUTS_RE.test(pathname) ||
    ORG_AGENTS_SESSION_INPUTS_ACK_RE.test(pathname) ||
    ORG_AGENTS_SESSION_WIRE_RE.test(pathname) ||
    ORG_AGENTS_PROVIDERS_RE.test(pathname) ||
    ORG_AGENTS_PROVIDER_RE.test(pathname) ||
    ORG_AGENTS_PROVIDER_VERIFY_RE.test(pathname) ||
    ORG_AGENTS_AUTONOMY_RE.test(pathname) ||
    ORG_AGENTS_ATTENTION_RE.test(pathname) ||
    ORG_AGENTS_ROUTINES_RE.test(pathname) ||
    ORG_AGENTS_ROUTINE_RE.test(pathname) ||
    ORG_AGENTS_BUDGETS_RE.test(pathname) ||
    ORG_AGENTS_BUDGET_RE.test(pathname) ||
    ORG_AGENTS_DISPATCH_RE.test(pathname)
  );
}

/** True for routes a browser head reaches with transports that cannot set an
 * Authorization header (WebSocket, EventSource): the attach feed only. On
 * these routes an `access_token` query parameter is accepted as the bearer —
 * synthesized into the Authorization header BEFORE actor resolution and
 * STRIPPED before forwarding (it must never reach logs or the worker). */
function allowsQueryToken(pathname: string): boolean {
  return ORG_AGENTS_SESSION_ATTACH_RE.test(pathname);
}

/**
 * handleAgentsUpgrade forwards a WebSocket upgrade (saas-agents-native
 * AN0/AN2: the body wire + the console socket) straight through to the
 * agents-worker with the resolved actor stamped — no idempotency layer, no
 * body handling, the upgrade Response returned untouched so the runtime can
 * complete the handshake end-to-end.
 */
async function handleAgentsUpgrade(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  if (!env.IDENTITY_WORKER || !env.AGENTS_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const url = new URL(request.url);
  let authed = request;
  if (!request.headers.get("authorization") && allowsQueryToken(pathname)) {
    const qt = url.searchParams.get("access_token");
    if (qt) {
      authed = new Request(request);
      authed.headers.set("authorization", `Bearer ${qt}`);
    }
  }
  const sessionResult = await resolveActor(authed, env, requestId);
  if ("error" in sessionResult) return sessionResult.error;

  url.searchParams.delete("access_token");
  const target = new URL(pathname + url.search, "https://agents.internal");
  const fwd = new Request(target.toString(), request);
  fwd.headers.delete("authorization");
  fwd.headers.set("x-request-id", requestId);
  fwd.headers.set("x-actor-subject-id", sessionResult.subjectId);
  fwd.headers.set("x-actor-subject-type", sessionResult.subjectType);
  fwd.headers.set("x-actor-email", sessionResult.email);
  if (sessionResult.agentSessionId) {
    fwd.headers.set("x-actor-agent-session-id", sessionResult.agentSessionId);
  }
  try {
    return await env.AGENTS_WORKER.fetch(fwd);
  } catch {
    return errorResponse("internal_error", "Agents service unavailable", 503, requestId);
  }
}

export async function handleAgentsRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (!allowedMethods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleAgentsUpgrade(request, env, requestId, pathname);
  }

  return replayOrExecute(request, requestId, env, "agents", async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    if (!env.AGENTS_WORKER) {
      return errorResponse("internal_error", "Agents service unavailable", 503, requestId);
    }

    // EventSource (the SSE fallback head) cannot set headers either — the
    // attach route accepts the query bearer on plain GETs too, same rules.
    let authed = request;
    if (!request.headers.get("authorization") && allowsQueryToken(pathname)) {
      const qt = new URL(request.url).searchParams.get("access_token");
      if (qt) {
        authed = new Request(request);
        authed.headers.set("authorization", `Bearer ${qt}`);
      }
    }
    const sessionResult = await resolveActor(authed, env, requestId);
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    // Session-bound runtime credential (AG6): the worker gates heartbeat/
    // ingest/refresh on this binding. Set ONLY from the resolved bearer —
    // an inbound x-actor-* header is never trusted or forwarded.
    if (sessionResult.agentSessionId) {
      headers.set("x-actor-agent-session-id", sessionResult.agentSessionId);
    }
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    url.searchParams.delete("access_token"); // never forwarded, never logged
    const target = new URL(pathname + url.search, "https://agents.internal");

    try {
      const fetchInit: RequestInit = { method: request.method, headers };
      if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
        fetchInit.body = request.body;
      }
      const downstream = await env.AGENTS_WORKER.fetch(target.toString(), fetchInit);
      return new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
    } catch {
      return errorResponse("internal_error", "Agents service unavailable", 503, requestId);
    }
  });
}
