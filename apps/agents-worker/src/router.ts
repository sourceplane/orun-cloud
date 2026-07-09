// agents-worker router (saas-agents AG5/AG6).
//
// AG5 shipped /health (dormant). AG6 lights up the workspace-scoped
// control-plane routes over the agents schema: profiles + sessions + the
// session-event relay read. Every call is re-entered through api-edge with the
// caller's credential (api-edge sets the x-actor-* headers after auth), and
// each handler authorizes deny-by-default through the policy worker. The
// per-session Durable Object relay, session-token mint, and sandbox
// provisioning are later AG6 slices; the live sandbox paths are
// Daytona-credential-gated.

import type { Env } from "./env.js";
import { buildDeps, ready, type AgentsDeps } from "./deps.js";
import { handleHealth } from "./handlers/health.js";
import { handleCreateProfile, handleListProfiles } from "./handlers/profiles.js";
import { handleCreateSession, handleGetSession, handleListSessions } from "./handlers/sessions.js";
import { handleListSessionEvents } from "./handlers/events.js";
import {
  handleCreateConnection,
  handleDeleteConnection,
  handleListConnections,
  handleVerifyConnection,
} from "./handlers/providers.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function generateRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

// Workspace(org)-scoped routes.
const PROFILES_RE = /^\/v1\/organizations\/([^/]+)\/agents\/profiles$/;
const SESSIONS_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions$/;
const SESSION_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions\/([^/]+)$/;
const SESSION_EVENTS_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions\/([^/]+)\/events$/;
const PROVIDERS_RE = /^\/v1\/organizations\/([^/]+)\/agents\/providers$/;
const PROVIDER_RE = /^\/v1\/organizations\/([^/]+)\/agents\/providers\/([^/]+)$/;
const PROVIDER_VERIFY_RE = /^\/v1\/organizations\/([^/]+)\/agents\/providers\/([^/]+)\/verify$/;

/**
 * route dispatches a request. `injectedDeps` lets unit tests drive the whole
 * control plane with a MemoryAgentsRepository + stub authorizer and no live
 * bindings; production passes none and deps are built from env.
 */
export async function route(request: Request, env: Env, injectedDeps?: AgentsDeps): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    const isAgentsRoute =
      PROFILES_RE.test(url.pathname) ||
      SESSIONS_RE.test(url.pathname) ||
      SESSION_RE.test(url.pathname) ||
      SESSION_EVENTS_RE.test(url.pathname) ||
      PROVIDERS_RE.test(url.pathname) ||
      PROVIDER_RE.test(url.pathname) ||
      PROVIDER_VERIFY_RE.test(url.pathname);
    if (!isAgentsRoute) {
      return notFound(requestId, url.pathname);
    }

    const actor = resolveActor(request);
    if (!actor) {
      return errorResponse("unauthenticated", "Authentication required", 401, requestId);
    }
    if (!injectedDeps && !ready(env)) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const deps = injectedDeps ?? buildDeps(env);
    try {
      return await dispatch(request, url, deps, actor, requestId);
    } finally {
      if (!injectedDeps) await deps.dispose();
    }
  } catch {
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}

async function dispatch(
  request: Request,
  url: URL,
  deps: AgentsDeps,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  let m = PROFILES_RE.exec(url.pathname);
  if (m) {
    const orgId = m[1]!;
    if (request.method === "GET") return handleListProfiles(deps, orgId, actor, requestId);
    if (request.method === "POST") return handleCreateProfile(request, deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = PROVIDER_VERIFY_RE.exec(url.pathname);
  if (m) {
    const orgId = m[1]!;
    const connectionId = m[2]!;
    if (request.method === "POST") return handleVerifyConnection(deps, orgId, connectionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = PROVIDER_RE.exec(url.pathname);
  if (m) {
    const orgId = m[1]!;
    const connectionId = m[2]!;
    if (request.method === "DELETE") return handleDeleteConnection(deps, orgId, connectionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = PROVIDERS_RE.exec(url.pathname);
  if (m) {
    const orgId = m[1]!;
    if (request.method === "GET") return handleListConnections(request, deps, orgId, actor, requestId);
    if (request.method === "POST") return handleCreateConnection(request, deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSION_EVENTS_RE.exec(url.pathname);
  if (m) {
    const orgId = m[1]!;
    const sessionId = m[2]!;
    if (request.method === "GET") return handleListSessionEvents(deps, orgId, sessionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSION_RE.exec(url.pathname);
  if (m) {
    const orgId = m[1]!;
    const sessionId = m[2]!;
    if (request.method === "GET") return handleGetSession(deps, orgId, sessionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSIONS_RE.exec(url.pathname);
  if (m) {
    const orgId = m[1]!;
    if (request.method === "GET") return handleListSessions(request, deps, orgId, actor, requestId);
    if (request.method === "POST") return handleCreateSession(request, deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  return notFound(requestId, url.pathname);
}
