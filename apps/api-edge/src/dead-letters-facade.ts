import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { enforceRateLimit, mergeRateLimitHeaders } from "./rate-limit.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

// Dead-letter ops surface (saas-event-streaming ES1): list + replay, forwarded
// to events-worker. Same facade discipline as the audit route — the edge
// authenticates the session, stamps actor headers, and forwards; authorization
// (dead_letter.read / dead_letter.replay) happens in events-worker via policy.

const ORG_DEAD_LETTERS_RE = /^\/v1\/organizations\/[^/]+\/dead-letters$/;
const ORG_DEAD_LETTER_REPLAY_RE = /^\/v1\/organizations\/[^/]+\/dead-letters\/[^/]+\/replay$/;

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
];

export function isDeadLettersRoute(pathname: string): boolean {
  return ORG_DEAD_LETTERS_RE.test(pathname) || ORG_DEAD_LETTER_REPLAY_RE.test(pathname);
}

export async function handleDeadLettersRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const isReplay = ORG_DEAD_LETTER_REPLAY_RE.test(pathname);
  const allowedMethod = isReplay ? "POST" : "GET";
  if (request.method !== allowedMethod) {
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

  try {
    const downstream = await timings.measure("edge_downstream", () =>
      env.EVENTS_WORKER!.fetch(target.toString(), {
        method: allowedMethod,
        headers,
      }),
    );
    endTotal();
    return mergeRateLimitHeaders(
      withEdgeTimings(
        new Response(downstream.body, {
          status: downstream.status,
          headers: downstream.headers,
        }),
        requestId,
        "edge.dead_letters",
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
