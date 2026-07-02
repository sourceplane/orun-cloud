import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";

// Organization-scoped config
const ORG_CONFIG_SETTINGS_RE = /^\/v1\/organizations\/[^/]+\/config\/settings(\/[^/]+)?$/;
const ORG_CONFIG_FLAGS_RE = /^\/v1\/organizations\/[^/]+\/config\/feature-flags(\/[^/]+)?$/;
// Secrets subpaths (saas-secret-manager SM1/SM5/SEC7): a single trailing segment
// covers item ids, `/import`, and `/syncs`; `/rotate`, `/versions`, and the SEC7
// break-glass `/reveal` nest one deeper. `/syncs` is called out explicitly (the
// SM5 provenance collection).
const ORG_CONFIG_SECRETS_RE = /^\/v1\/organizations\/[^/]+\/config\/secrets(\/syncs|\/[^/]+(\/(rotate|versions|reveal))?)?$/;
// SecretPolicy documents (SM3): PUT collection + POST /evaluate. NOTE: the
// lease-verified value resolve lives at /v1/internal/config/secrets/resolve and
// is DELIBERATELY absent here — api-edge never forwards /v1/internal/*, so the
// only reachable caller is the state-worker service binding.
const ORG_CONFIG_SECRET_POLICIES_RE = /^\/v1\/organizations\/[^/]+\/config\/secret-policies(\/evaluate)?$/;

// Project-scoped config
const PRJ_CONFIG_SETTINGS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/config\/settings(\/[^/]+)?$/;
const PRJ_CONFIG_FLAGS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/config\/feature-flags(\/[^/]+)?$/;
const PRJ_CONFIG_SECRETS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/config\/secrets(\/syncs|\/[^/]+(\/(rotate|versions|reveal))?)?$/;
const PRJ_CONFIG_SECRET_POLICIES_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/config\/secret-policies(\/evaluate)?$/;

// Environment-scoped config
const ENV_CONFIG_SETTINGS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/environments\/[^/]+\/config\/settings(\/[^/]+)?$/;
const ENV_CONFIG_FLAGS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/environments\/[^/]+\/config\/feature-flags(\/[^/]+)?$/;
const ENV_CONFIG_SECRETS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/environments\/[^/]+\/config\/secrets(\/syncs|\/[^/]+(\/(rotate|versions|reveal))?)?$/;

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
];

export function isConfigRoute(pathname: string): boolean {
  return (
    ORG_CONFIG_SETTINGS_RE.test(pathname) ||
    ORG_CONFIG_FLAGS_RE.test(pathname) ||
    ORG_CONFIG_SECRETS_RE.test(pathname) ||
    ORG_CONFIG_SECRET_POLICIES_RE.test(pathname) ||
    PRJ_CONFIG_SETTINGS_RE.test(pathname) ||
    PRJ_CONFIG_FLAGS_RE.test(pathname) ||
    PRJ_CONFIG_SECRETS_RE.test(pathname) ||
    PRJ_CONFIG_SECRET_POLICIES_RE.test(pathname) ||
    ENV_CONFIG_SETTINGS_RE.test(pathname) ||
    ENV_CONFIG_FLAGS_RE.test(pathname) ||
    ENV_CONFIG_SECRETS_RE.test(pathname)
  );
}

export async function handleConfigRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  // Config routes: GET (list), POST (create/rotate/evaluate), PUT (policy push),
  // PATCH (update), DELETE (revoke)
  const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (!allowedMethods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "config", async () => {

    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }

    if (!env.CONFIG_WORKER) {
      return errorResponse("internal_error", "Config service unavailable", 503, requestId);
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
    if (sessionResult.orgId) {
    }
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://config.internal");

    try {
      const fetchInit: RequestInit = {
        method: request.method,
        headers,
      };
      if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
        fetchInit.body = request.body;
      }
      const downstream = await env.CONFIG_WORKER.fetch(target.toString(), fetchInit);
      return new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
    } catch {
      return errorResponse("internal_error", "Config service unavailable", 503, requestId);
    }
  });
}
