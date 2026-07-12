import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { enforceRateLimit, mergeRateLimitHeaders } from "./rate-limit.js";
import { resolveActor } from "./resolve-actor.js";

// Authenticated org-scoped integration routes → integrations-worker.
const ORG_INTEGRATIONS_RE = /^\/v1\/organizations\/[^/]+\/integrations(\/.*)?$/;
// Project-scoped repo links (IG3) live in the integrations bounded context.
const PROJECT_REPO_LINKS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/repo-links(\/.*)?$/;

// Public install-callback ingress (design §5): GitHub redirects the installing
// user's BROWSER here after an App install. There is no bearer token — the
// request authenticates via the signed single-use state inside the query
// string, which integrations-worker (owner of the state secret) verifies.
// Allowlist-routed: exactly this one path, GET only, rate-limited.
const GITHUB_SETUP_PATH = "/ingress/github/setup";

// Public inbound webhook ingress (design §5): GitHub POSTs signed deliveries
// here. The edge does NOT verify or parse — it streams the RAW body plus the
// signature headers to integrations-worker, which owns the webhook secret
// and verifies over raw bytes before any parse (same posture as the Polar
// billing webhook). Allowlist-routed; rate-limited per source.
const GITHUB_WEBHOOK_PATH = "/ingress/github/webhook";

// Public Slack OAuth-callback ingress (IH1, design §4.1): Slack redirects the
// installing user's BROWSER here after the consent screen. Same posture as
// the GitHub setup path — no bearer, authenticated by the signed single-use
// state integrations-worker verifies. Allowlist-routed, GET only, rate-limited.
const SLACK_OAUTH_PATH = "/ingress/slack/oauth";

// Public Supabase OAuth-callback ingress (IH6, design §5.3): same posture as
// the Slack OAuth path — no bearer, authenticated by the signed single-use
// state (plus PKCE) integrations-worker verifies. Allowlist-routed, GET only,
// rate-limited.
const SUPABASE_OAUTH_PATH = "/ingress/supabase/oauth";

// Public Slack inbound ingress (IH3, design §4.3): Slack POSTs signed
// requests here — Events API (JSON), slash commands and interactivity
// (form-encoded). Same posture as the GitHub webhook: the edge does NOT
// verify or parse — it streams the RAW body plus the v0 signature headers to
// integrations-worker, which owns the signing secret and verifies over raw
// bytes before any parse. Allowlist-routed; rate-limited per source.
const SLACK_EVENTS_PATH = "/ingress/slack/events";
const SLACK_COMMANDS_PATH = "/ingress/slack/commands";
const SLACK_INTERACTIVITY_PATH = "/ingress/slack/interactivity";

const SLACK_INBOUND_PATHS: ReadonlySet<string> = new Set([
  SLACK_EVENTS_PATH,
  SLACK_COMMANDS_PATH,
  SLACK_INTERACTIVITY_PATH,
]);

const FORWARDED_WEBHOOK_HEADERS = [
  "content-type",
  "x-github-delivery",
  "x-github-event",
  "x-hub-signature-256",
  // Slack v0 request signing (IH3) — verified over raw bytes by the worker.
  "x-slack-signature",
  "x-slack-request-timestamp",
];

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
];

export function isIntegrationsRoute(pathname: string): boolean {
  return ORG_INTEGRATIONS_RE.test(pathname) || PROJECT_REPO_LINKS_RE.test(pathname);
}

export function isIntegrationsIngressRoute(pathname: string): boolean {
  return (
    pathname === GITHUB_SETUP_PATH ||
    pathname === GITHUB_WEBHOOK_PATH ||
    pathname === SLACK_OAUTH_PATH ||
    pathname === SUPABASE_OAUTH_PATH ||
    SLACK_INBOUND_PATHS.has(pathname)
  );
}

export async function handleIntegrationsIngressRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  if (!env.INTEGRATIONS_WORKER) {
    return errorResponse("internal_error", "Integrations service unavailable", 503, requestId);
  }

  if (pathname === GITHUB_WEBHOOK_PATH || SLACK_INBOUND_PATHS.has(pathname)) {
    if (request.method !== "POST") {
      return errorResponse("unsupported", "Method not allowed", 405, requestId);
    }
    const rateDecision = await enforceRateLimit(request, requestId, env, "integrations");
    if (rateDecision.kind === "denied") {
      return rateDecision.response;
    }
    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-internal-caller", "api-edge");
    for (const name of FORWARDED_WEBHOOK_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const target = new URL(pathname, "https://integrations.internal");
    try {
      // Stream the raw body through unread so the bytes GitHub signed reach
      // the verifier intact.
      const downstream = await env.INTEGRATIONS_WORKER.fetch(target.toString(), {
        method: "POST",
        headers,
        body: request.body,
      });
      return mergeRateLimitHeaders(
        new Response(downstream.body, {
          status: downstream.status,
          headers: downstream.headers,
        }),
        rateDecision.headers,
      );
    } catch {
      return errorResponse("internal_error", "Integrations service unavailable", 503, requestId);
    }
  }

  if (request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  // Per-source rate limit on the bearer-less surface (keyed by IP for
  // anonymous callers). No resolveActor, no tenant lookup at the edge.
  const rateDecision = await enforceRateLimit(request, requestId, env, "integrations");
  if (rateDecision.kind === "denied") {
    return rateDecision.response;
  }

  const headers = new Headers();
  headers.set("x-request-id", requestId);
  headers.set("x-internal-caller", "api-edge");

  const url = new URL(request.url);
  const target = new URL(pathname + url.search, "https://integrations.internal");
  try {
    const downstream = await env.INTEGRATIONS_WORKER.fetch(target.toString(), {
      method: "GET",
      headers,
    });
    return mergeRateLimitHeaders(
      new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      }),
      rateDecision.headers,
    );
  } catch {
    return errorResponse("internal_error", "Integrations service unavailable", 503, requestId);
  }
}

export async function handleIntegrationsRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const allowedMethods = ["GET", "POST", "PATCH", "DELETE"];
  if (!allowedMethods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  const rateDecision = await enforceRateLimit(request, requestId, env, "integrations");
  if (rateDecision.kind === "denied") {
    return rateDecision.response;
  }
  const rateHeaders = rateDecision.headers;

  return replayOrExecute(request, requestId, env, "integrations", async () => {
    if (!env.IDENTITY_WORKER) {
      return mergeRateLimitHeaders(
        errorResponse("internal_error", "Authentication service unavailable", 503, requestId),
        rateHeaders,
      );
    }
    if (!env.INTEGRATIONS_WORKER) {
      return mergeRateLimitHeaders(
        errorResponse("internal_error", "Integrations service unavailable", 503, requestId),
        rateHeaders,
      );
    }

    const sessionResult = await resolveActor(request, env, requestId);
    if ("error" in sessionResult) {
      return mergeRateLimitHeaders(sessionResult.error, rateHeaders);
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
    const target = new URL(pathname + url.search, "https://integrations.internal");

    try {
      const fetchInit: RequestInit = {
        method: request.method,
        headers,
      };
      if (request.method === "POST" || request.method === "PATCH") {
        fetchInit.body = request.body;
      }
      const downstream = await env.INTEGRATIONS_WORKER.fetch(target.toString(), fetchInit);
      return mergeRateLimitHeaders(
        new Response(downstream.body, {
          status: downstream.status,
          headers: downstream.headers,
        }),
        rateHeaders,
      );
    } catch {
      return mergeRateLimitHeaders(
        errorResponse("internal_error", "Integrations service unavailable", 503, requestId),
        rateHeaders,
      );
    }
  });
}
