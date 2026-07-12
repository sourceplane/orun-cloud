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
import { handleAttach, handleHeadInput } from "./handlers/relay.js";
import { handleProvisionSession } from "./handlers/provision.js";
import {
  handleIngestSessionEvent,
  handleRefreshSessionToken,
  handleSessionHeartbeat,
} from "./handlers/runtime.js";
import { handleGetAutonomy, handleSetAutonomy } from "./handlers/autonomy.js";
import { handleGetAttention } from "./handlers/attention.js";
import { handleCancelSession } from "./handlers/tree.js";
import {
  handleCreateRoutine,
  handleDeleteRoutine,
  handleListRoutines,
  handleUpdateRoutine,
} from "./handlers/routines.js";
import { handleListRecords, handleSetProfileAutonomy } from "./handlers/records.js";
import { handleDeleteBudget, handleListBudgets, handleSetBudget } from "./handlers/budgets.js";
import { handleDispatch } from "./handlers/dispatch.js";
import {
  handleCreateConnection,
  handleDeleteConnection,
  handleListConnections,
  handleVerifyConnection,
} from "./handlers/providers.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import { uuidFromPublicId } from "@saas/db/ids";

// Every agents route is workspace-scoped: the URL carries the PUBLIC org id
// (`org_<hex>`), but membership/policy and the `org_id UUID` columns require
// the decoded UUID. Decode once at the boundary (the universal worker
// convention); a malformed id is a 404, never a leak.
function parseOrgPublicId(publicId: string): string | null {
  return uuidFromPublicId(publicId, "org");
}

export interface ActorContext {
  subjectId: string;
  subjectType: string;
  /** The agent session an agent-session token is bound to (AG6 §3.2), from
   * x-actor-agent-session-id — set by api-edge only for agent-session bearers. */
  agentSessionId?: string;
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
  const agentSessionId = request.headers.get("x-actor-agent-session-id");
  return { subjectId, subjectType, ...(agentSessionId ? { agentSessionId } : {}) };
}

// Workspace(org)-scoped routes.
const PROFILES_RE = /^\/v1\/organizations\/([^/]+)\/agents\/profiles$/;
// Earned autonomy (saas-agents-fleet AF7): the profile item (autonomy PATCH)
// and the org-wide record read.
const PROFILE_RE = /^\/v1\/organizations\/([^/]+)\/agents\/profiles\/([^/]+)$/;
const RECORDS_RE = /^\/v1\/organizations\/([^/]+)\/agents\/records$/;
const SESSIONS_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions$/;
const SESSION_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions\/([^/]+)$/;
const SESSION_EVENTS_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions\/([^/]+)\/events$/;
const SESSION_PROVISION_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions\/([^/]+)\/provision$/;
// Tree-transitive kill (saas-agents-fleet AF4): cancel the node + its subtree.
const SESSION_CANCEL_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions\/([^/]+)\/cancel$/;
const SESSION_HEARTBEAT_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions\/([^/]+)\/heartbeat$/;
const SESSION_TOKEN_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions\/([^/]+)\/token$/;
// Head-facing relay routes (saas-agents-live AL6): SSE feed + input.
const SESSION_ATTACH_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions\/([^/]+)\/attach$/;
const SESSION_INPUT_RE = /^\/v1\/organizations\/([^/]+)\/agents\/sessions\/([^/]+)\/input$/;
const AUTONOMY_RE = /^\/v1\/organizations\/([^/]+)\/agents\/autonomy$/;
// The needs-you fold (saas-agents-fleet AF5): a derived read, no storage.
const ATTENTION_RE = /^\/v1\/organizations\/([^/]+)\/agents\/attention$/;
// Standing routines (saas-agents-fleet AF6): registry CRUD + resume.
const ROUTINES_RE = /^\/v1\/organizations\/([^/]+)\/agents\/routines$/;
const ROUTINE_RE = /^\/v1\/organizations\/([^/]+)\/agents\/routines\/([^/]+)$/;
// Budgets (saas-agents-fleet AF8): the ceilings registry.
const BUDGETS_RE = /^\/v1\/organizations\/([^/]+)\/agents\/budgets$/;
const BUDGET_RE = /^\/v1\/organizations\/([^/]+)\/agents\/budgets\/([^/]+)$/;
const DISPATCH_RE = /^\/v1\/organizations\/([^/]+)\/agents\/dispatch$/;
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
      PROFILE_RE.test(url.pathname) ||
      RECORDS_RE.test(url.pathname) ||
      SESSIONS_RE.test(url.pathname) ||
      SESSION_RE.test(url.pathname) ||
      SESSION_EVENTS_RE.test(url.pathname) ||
      SESSION_PROVISION_RE.test(url.pathname) ||
      SESSION_CANCEL_RE.test(url.pathname) ||
      SESSION_HEARTBEAT_RE.test(url.pathname) ||
      SESSION_TOKEN_RE.test(url.pathname) ||
      SESSION_ATTACH_RE.test(url.pathname) ||
      SESSION_INPUT_RE.test(url.pathname) ||
      PROVIDERS_RE.test(url.pathname) ||
      PROVIDER_RE.test(url.pathname) ||
      PROVIDER_VERIFY_RE.test(url.pathname) ||
      AUTONOMY_RE.test(url.pathname) ||
      ATTENTION_RE.test(url.pathname) ||
      ROUTINES_RE.test(url.pathname) ||
      ROUTINE_RE.test(url.pathname) ||
      BUDGETS_RE.test(url.pathname) ||
      BUDGET_RE.test(url.pathname) ||
      DISPATCH_RE.test(url.pathname);
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
      return await dispatch(request, url, env, deps, actor, requestId);
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
  env: Env,
  deps: AgentsDeps,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  let m = PROFILE_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const profileId = m[2]!;
    if (request.method === "PATCH") {
      return handleSetProfileAutonomy(request, deps, orgId, profileId, actor, requestId);
    }
    return methodNotAllowed(requestId);
  }

  m = RECORDS_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    if (request.method === "GET") return handleListRecords(deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = PROFILES_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    if (request.method === "GET") return handleListProfiles(deps, orgId, actor, requestId);
    if (request.method === "POST") return handleCreateProfile(request, deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = AUTONOMY_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    if (request.method === "GET") return handleGetAutonomy(request, deps, orgId, actor, requestId);
    if (request.method === "PUT") return handleSetAutonomy(request, deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = DISPATCH_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    if (request.method === "POST") return handleDispatch(request, deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = ATTENTION_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    if (request.method === "GET") return handleGetAttention(deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = ROUTINE_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const routineId = m[2]!;
    if (request.method === "PATCH") return handleUpdateRoutine(request, deps, orgId, routineId, actor, requestId);
    if (request.method === "DELETE") return handleDeleteRoutine(deps, orgId, routineId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = BUDGET_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const budgetId = m[2]!;
    if (request.method === "DELETE") return handleDeleteBudget(deps, orgId, budgetId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = BUDGETS_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    if (request.method === "GET") return handleListBudgets(deps, orgId, actor, requestId);
    if (request.method === "PUT") return handleSetBudget(request, deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = ROUTINES_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    if (request.method === "GET") return handleListRoutines(deps, orgId, actor, requestId);
    if (request.method === "POST") return handleCreateRoutine(request, deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = PROVIDER_VERIFY_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const connectionId = m[2]!;
    if (request.method === "POST") return handleVerifyConnection(deps, orgId, connectionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = PROVIDER_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const connectionId = m[2]!;
    if (request.method === "DELETE") return handleDeleteConnection(deps, orgId, connectionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = PROVIDERS_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    if (request.method === "GET") return handleListConnections(request, deps, orgId, actor, requestId);
    if (request.method === "POST") return handleCreateConnection(request, deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSION_PROVISION_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const sessionId = m[2]!;
    if (request.method === "POST") return handleProvisionSession(deps, orgId, sessionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSION_CANCEL_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const sessionId = m[2]!;
    if (request.method === "POST") return handleCancelSession(deps, orgId, sessionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSION_HEARTBEAT_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const sessionId = m[2]!;
    if (request.method === "POST") return handleSessionHeartbeat(deps, orgId, sessionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSION_TOKEN_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const sessionId = m[2]!;
    if (request.method === "POST") return handleRefreshSessionToken(deps, orgId, sessionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSION_EVENTS_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const sessionId = m[2]!;
    if (request.method === "GET") return handleListSessionEvents(deps, orgId, sessionId, actor, requestId);
    if (request.method === "POST") return handleIngestSessionEvent(request, deps, orgId, env, sessionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSION_ATTACH_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const sessionId = m[2]!;
    if (request.method === "GET") {
      const from = Number(url.searchParams.get("from") ?? "-1");
      const surface = url.searchParams.get("surface") || "console";
      return handleAttach(env, deps, orgId, sessionId, actor, requestId, from, surface);
    }
    return methodNotAllowed(requestId);
  }

  m = SESSION_INPUT_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const sessionId = m[2]!;
    if (request.method === "POST") return handleHeadInput(request, env, deps, orgId, sessionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSION_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    const sessionId = m[2]!;
    if (request.method === "GET") return handleGetSession(deps, orgId, sessionId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  m = SESSIONS_RE.exec(url.pathname);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, url.pathname);
    if (request.method === "GET") return handleListSessions(request, deps, orgId, actor, requestId);
    if (request.method === "POST") return handleCreateSession(request, deps, orgId, actor, requestId);
    return methodNotAllowed(requestId);
  }

  return notFound(requestId, url.pathname);
}
