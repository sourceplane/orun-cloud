import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";

// Authenticated state-worker routes proxied through the edge (OP4 — workspace
// links + tenancy resolution; OP2+ run/object planes land behind the same
// facade). The owning worker (state-worker) re-runs deny-by-default policy on
// every route; the edge only authenticates the bearer and forwards the actor.

// Org-scoped workspace-link create (state-api-contract §5).
const ORG_CLI_LINKS_RE = /^\/v1\/organizations\/[^/]+\/cli\/links$/;
// Org-independent resolve picker (state-api-contract §5).
const CLI_LINKS_RESOLVE_PATH = "/v1/cli/links/resolve";
// Console-management list + unlink (project Settings → CLI page).
const ORG_PROJECT_CLI_LINKS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/cli\/links(\/[^/]+)?$/;

const FORWARDED_HEADERS = ["content-type", "x-request-id", "traceparent", "idempotency-key"];

export function isStateRoute(pathname: string): boolean {
  return (
    pathname === CLI_LINKS_RESOLVE_PATH ||
    ORG_CLI_LINKS_RE.test(pathname) ||
    ORG_PROJECT_CLI_LINKS_RE.test(pathname)
  );
}

export async function handleStateRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const allowedMethods = ["GET", "POST", "DELETE"];
  if (!allowedMethods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "state", async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    if (!env.STATE_WORKER) {
      return errorResponse("internal_error", "State service unavailable", 503, requestId);
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
    const target = new URL(pathname + url.search, "https://state.internal");

    try {
      const fetchInit: RequestInit = { method: request.method, headers };
      if (request.method === "POST") {
        fetchInit.body = request.body;
      }
      const downstream = await env.STATE_WORKER.fetch(target.toString(), fetchInit);
      return new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
    } catch {
      return errorResponse("internal_error", "State service unavailable", 503, requestId);
    }
  });
}
