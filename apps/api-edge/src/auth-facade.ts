import type { Env } from "./env";
import { errorResponse } from "./http";
import { replayOrExecute } from "./idempotency";
import { cacheApiStore, bearerToken } from "./actor-cache";
import { resolveActor } from "./resolve-actor";

const LOGOUT_PATH = "/v1/auth/logout";

const AUTH_ROUTES: Record<string, string> = {
  "/v1/auth/login/start": "POST",
  "/v1/auth/login/complete": "POST",
  "/v1/auth/session": "GET",
  "/v1/auth/resolve": "GET",
  "/v1/auth/logout": "POST",
  "/v1/auth/security-events": "GET",
  // CLI session auth (OP1). Unauthenticated CLI-facing endpoints; forwarded to
  // identity-worker. The "auth" route family rate-limits start/poll/token here.
  "/v1/auth/cli/start": "POST",
  "/v1/auth/cli/device/start": "POST",
  "/v1/auth/cli/device/poll": "POST",
  "/v1/auth/cli/token": "POST",
  "/v1/auth/cli/revoke": "POST",
  // GitHub Actions OIDC exchange (OV3). Public/unauthenticated: the OIDC token
  // in the body IS the credential, so it forwards to identity-worker without a
  // bearer (not in cliRouteRequiresAuth).
  "/v1/auth/oidc/exchange": "POST",
  // Console: authenticated CLI session listing.
  "/v1/auth/cli/sessions": "GET",
};

const AUTH_MULTI_METHOD_ROUTES: Record<string, Set<string>> = {
  "/v1/auth/profile": new Set(["GET", "PATCH"]),
};

// CLI grant management + per-session revoke have a dynamic id segment, so they
// are matched by pattern. All are authenticated (api-edge injects actor headers).
const CLI_GRANT_GET_RE = /^\/v1\/auth\/cli\/grants\/[^/]+$/;
const CLI_GRANT_APPROVE_RE = /^\/v1\/auth\/cli\/grants\/[^/]+\/approve$/;
const CLI_GRANT_DENY_RE = /^\/v1\/auth\/cli\/grants\/[^/]+\/deny$/;
const CLI_SESSION_ID_RE = /^\/v1\/auth\/cli\/sessions\/[^/]+$/;

// Routes that require an authenticated console user (api-edge resolves the
// bearer and injects x-actor-* headers before forwarding).
const CLI_AUTHED_GET_PATHS = new Set<string>(["/v1/auth/cli/sessions"]);

function cliManagedRoute(pathname: string, method: string): boolean {
  if (CLI_GRANT_APPROVE_RE.test(pathname) || CLI_GRANT_DENY_RE.test(pathname)) return method === "POST";
  if (CLI_GRANT_GET_RE.test(pathname)) return method === "GET";
  if (CLI_SESSION_ID_RE.test(pathname)) return method === "DELETE";
  return false;
}

/** Does this CLI route need the caller to be an authenticated console user? */
function cliRouteRequiresAuth(pathname: string): boolean {
  if (CLI_AUTHED_GET_PATHS.has(pathname)) return true;
  if (CLI_SESSION_ID_RE.test(pathname)) return true;
  if (CLI_GRANT_APPROVE_RE.test(pathname) || CLI_GRANT_DENY_RE.test(pathname)) return true;
  if (CLI_GRANT_GET_RE.test(pathname)) return true;
  return false;
}

// OAuth sign-in routes (all GET). `start` and `callback` are browser-redirect
// navigations; `providers` is a JSON read. The `:provider` segment is dynamic,
// so these are matched by pattern rather than the static route map.
const OAUTH_PROVIDERS_PATH = "/v1/auth/oauth/providers";
const OAUTH_START_RE = /^\/v1\/auth\/oauth\/[^/]+\/start$/;
const OAUTH_CALLBACK_RE = /^\/v1\/auth\/oauth\/[^/]+\/callback$/;

function isOAuthRoute(pathname: string): boolean {
  return (
    pathname === OAUTH_PROVIDERS_PATH ||
    OAUTH_START_RE.test(pathname) ||
    OAUTH_CALLBACK_RE.test(pathname)
  );
}

const FORWARDED_HEADERS = [
  "authorization",
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
  // Forwarded so the OAuth callback can read the state cookie set by `start`
  // (double-submit CSRF defense). Cookies are first-party to api-edge.
  "cookie",
];

function isCliManagedPath(pathname: string): boolean {
  return (
    CLI_GRANT_GET_RE.test(pathname) ||
    CLI_GRANT_APPROVE_RE.test(pathname) ||
    CLI_GRANT_DENY_RE.test(pathname) ||
    CLI_SESSION_ID_RE.test(pathname)
  );
}

export function isAuthRoute(pathname: string): boolean {
  return (
    pathname in AUTH_ROUTES ||
    pathname in AUTH_MULTI_METHOD_ROUTES ||
    isOAuthRoute(pathname) ||
    isCliManagedPath(pathname)
  );
}

export async function handleAuthRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const expectedMethod = AUTH_ROUTES[pathname];
  const allowedMethods = AUTH_MULTI_METHOD_ROUTES[pathname];
  const oauth = isOAuthRoute(pathname);
  const cliManaged = isCliManagedPath(pathname);

  if (!expectedMethod && !allowedMethods && !oauth && !cliManaged) {
    return errorResponse("not_found", `Route not found: ${pathname}`, 404, requestId);
  }

  if (oauth) {
    if (request.method !== "GET") {
      return errorResponse("unsupported", "Method not allowed", 405, requestId);
    }
  } else if (cliManaged) {
    if (!cliManagedRoute(pathname, request.method)) {
      return errorResponse("unsupported", "Method not allowed", 405, requestId);
    }
  } else if (expectedMethod && request.method !== expectedMethod) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  } else if (allowedMethods && !allowedMethods.has(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  // Authenticated CLI routes (grant approve/deny/get, session list/revoke) need
  // the actor resolved + injected as x-actor-* headers, exactly like org-facade.
  const requiresAuth = cliRouteRequiresAuth(pathname);

  return replayOrExecute(request, requestId, env, "auth", async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse(
        "internal_error",
        "Authentication service unavailable",
        503,
        requestId,
      );
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    if (requiresAuth) {
      const actor = await resolveActor(request, env, requestId);
      if ("error" in actor) return actor.error;
      headers.set("x-actor-subject-id", actor.subjectId);
      headers.set("x-actor-subject-type", actor.subjectType);
      headers.set("x-actor-email", actor.email);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://identity.internal");

    const init: RequestInit = {
      method: request.method,
      headers,
      // OAuth `start`/`callback` return 302s (to the provider, then back to the
      // console). Without manual mode the service-binding fetch would FOLLOW
      // them server-side instead of handing the redirect to the browser.
      // Other auth routes never redirect, so this is inert for them.
      redirect: "manual",
    };

    if (request.method === "POST" || request.method === "PATCH") {
      init.body = request.body;
    }

    try {
      const downstream = await env.IDENTITY_WORKER.fetch(target.toString(), init);
      // On a successful logout, evict the cached actor so the (now-revoked)
      // session can't be served from the edge cache for the rest of its TTL.
      if (pathname === LOGOUT_PATH && downstream.ok) {
        const token = bearerToken(request.headers.get("authorization"));
        if (token) await cacheApiStore().evict(token);
      }
      return new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
    } catch {
      return errorResponse(
        "internal_error",
        "Authentication service unavailable",
        503,
        requestId,
      );
    }
  });
}
