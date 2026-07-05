import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { enforceRateLimit, mergeRateLimitHeaders } from "./rate-limit.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

// Notification rules facade (saas-event-streaming ES2): CRUD + test-fire,
// forwarded to events-worker. The edge authenticates the session and stamps
// actor headers; authorization (organization.notification_rule.read/write)
// and entitlement gating happen in events-worker.

const ORG_RULES_RE = /^\/v1\/organizations\/[^/]+\/notification-rules$/;
const ORG_RULE_RE = /^\/v1\/organizations\/[^/]+\/notification-rules\/[^/]+$/;
const ORG_RULE_TEST_RE = /^\/v1\/organizations\/[^/]+\/notification-rules\/[^/]+\/test$/;

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
];

export function isNotificationRulesRoute(pathname: string): boolean {
  return ORG_RULES_RE.test(pathname) || ORG_RULE_RE.test(pathname) || ORG_RULE_TEST_RE.test(pathname);
}

function allowedMethods(pathname: string): string[] {
  if (ORG_RULE_TEST_RE.test(pathname)) return ["POST"];
  if (ORG_RULE_RE.test(pathname)) return ["GET", "PATCH", "DELETE"];
  return ["GET", "POST"];
}

export async function handleNotificationRulesRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const methods = allowedMethods(pathname);
  if (!methods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  const rateDecision = await enforceRateLimit(request, requestId, env, "audit");
  if (rateDecision.kind === "denied") {
    return rateDecision.response;
  }
  const rateHeaders = rateDecision.headers;

  if (!env.IDENTITY_WORKER) {
    return mergeRateLimitHeaders(
      errorResponse("internal_error", "Authentication service unavailable", 503, requestId),
      rateHeaders,
    );
  }
  if (!env.EVENTS_WORKER) {
    return mergeRateLimitHeaders(
      errorResponse("internal_error", "Events service unavailable", 503, requestId),
      rateHeaders,
    );
  }

  const timings = createTimings();
  const endTotal = timings.start("edge_total");
  const sessionResult = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
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
  const target = new URL(pathname + url.search, "https://events.internal");

  const fetchInit: RequestInit = { method: request.method, headers };
  if (request.method === "POST" || request.method === "PATCH") {
    fetchInit.body = request.body;
  }

  try {
    const downstream = await timings.measure("edge_downstream", () =>
      env.EVENTS_WORKER!.fetch(target.toString(), fetchInit),
    );
    endTotal();
    return mergeRateLimitHeaders(
      withEdgeTimings(
        new Response(downstream.body, {
          status: downstream.status,
          headers: downstream.headers,
        }),
        requestId,
        "edge.notification_rules",
        timings,
      ),
      rateHeaders,
    );
  } catch {
    return mergeRateLimitHeaders(
      errorResponse("internal_error", "Events service unavailable", 503, requestId),
      rateHeaders,
    );
  }
}
