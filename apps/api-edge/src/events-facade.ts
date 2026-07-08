import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { enforceRateLimit, mergeRateLimitHeaders } from "./rate-limit.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

// Events facade (saas-event-streaming ES5): custom-event ingest (POST) and the
// events explorer (GET list + GET single), forwarded to events-worker. Unlike
// the read-only audit/event-groups facades, the collection accepts POST as well
// as GET. The edge authenticates the session and stamps actor headers;
// authorization (organization.event.ingest / .read) and entitlement gating
// happen downstream.

const ORG_EVENTS_RE = /^\/v1\/organizations\/[^/]+\/events$/;
const ORG_EVENT_RE = /^\/v1\/organizations\/[^/]+\/events\/[^/]+$/;

const FORWARDED_HEADERS = ["content-type", "x-request-id", "traceparent", "idempotency-key"];

export function isEventsRoute(pathname: string): boolean {
  return ORG_EVENTS_RE.test(pathname) || ORG_EVENT_RE.test(pathname);
}

function allowedMethods(pathname: string): string[] {
  if (ORG_EVENT_RE.test(pathname)) return ["GET"];
  return ["GET", "POST"];
}

export async function handleEventsRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  if (!allowedMethods(pathname).includes(request.method)) {
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
  if (request.method === "POST") {
    fetchInit.body = request.body;
  }

  try {
    const downstream = await timings.measure("edge_downstream", () =>
      env.EVENTS_WORKER!.fetch(target.toString(), fetchInit),
    );
    endTotal();
    return mergeRateLimitHeaders(
      withEdgeTimings(
        new Response(downstream.body, { status: downstream.status, headers: downstream.headers }),
        requestId,
        "edge.events",
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
