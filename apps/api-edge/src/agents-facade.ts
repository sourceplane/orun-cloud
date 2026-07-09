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
const ORG_AGENTS_SESSIONS_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions$/;
const ORG_AGENTS_SESSION_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+$/;
const ORG_AGENTS_SESSION_EVENTS_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/events$/;
const ORG_AGENTS_SESSION_PROVISION_RE = /^\/v1\/organizations\/[^/]+\/agents\/sessions\/[^/]+\/provision$/;
// Provider connections (AG12 §10): BYO Daytona / Anthropic keys. The apiKey in
// the create body transits this facade exactly once, straight to the worker —
// never logged, never cached (idempotency stores replay by key, not body).
const ORG_AGENTS_PROVIDERS_RE = /^\/v1\/organizations\/[^/]+\/agents\/providers$/;
const ORG_AGENTS_PROVIDER_RE = /^\/v1\/organizations\/[^/]+\/agents\/providers\/[^/]+$/;
const ORG_AGENTS_PROVIDER_VERIFY_RE = /^\/v1\/organizations\/[^/]+\/agents\/providers\/[^/]+\/verify$/;

const FORWARDED_HEADERS = ["content-type", "x-request-id", "traceparent", "idempotency-key"];

export function isAgentsRoute(pathname: string): boolean {
  return (
    ORG_AGENTS_PROFILES_RE.test(pathname) ||
    ORG_AGENTS_SESSIONS_RE.test(pathname) ||
    ORG_AGENTS_SESSION_RE.test(pathname) ||
    ORG_AGENTS_SESSION_EVENTS_RE.test(pathname) ||
    ORG_AGENTS_SESSION_PROVISION_RE.test(pathname) ||
    ORG_AGENTS_PROVIDERS_RE.test(pathname) ||
    ORG_AGENTS_PROVIDER_RE.test(pathname) ||
    ORG_AGENTS_PROVIDER_VERIFY_RE.test(pathname)
  );
}

export async function handleAgentsRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const allowedMethods = ["GET", "POST", "DELETE"];
  if (!allowedMethods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "agents", async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    if (!env.AGENTS_WORKER) {
      return errorResponse("internal_error", "Agents service unavailable", 503, requestId);
    }

    const sessionResult = await resolveActor(request, env, requestId);
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://agents.internal");

    try {
      const fetchInit: RequestInit = { method: request.method, headers };
      if (request.method === "POST") {
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
