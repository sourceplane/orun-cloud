// mcp-worker router (saas-mcp-server MCP2).
//
// Routes: POST /mcp (also POST /) → the stateless Streamable HTTP handler;
// GET /health; everything else 404/405. Structured request logs carry method,
// path, status, duration, request id — NEVER the bearer.

import type { McpWorkerDeps } from "./deps.js";
import { buildDeps } from "./deps.js";
import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleMcpPost } from "./handlers/mcp.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// Cheap per-isolate self-protection (design §8): an in-memory in-flight cap,
// mirroring the edge's fail-open posture — no KV/DO, resets with the isolate.
export const MAX_CONCURRENT_REQUESTS = 32;
let inFlight = 0;

export async function route(request: Request, env: Env, injectedDeps?: McpWorkerDeps): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await dispatch(request, url, env, requestId, injectedDeps);
  } catch {
    response = errorResponse("internal_error", "Internal error", 500, requestId);
  }
  // eslint-disable-next-line no-console -- structured request line for prod observability
  console.log(
    JSON.stringify({
      level: "info",
      msg: "request",
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt,
      requestId,
    }),
  );
  return response;
}

async function dispatch(
  request: Request,
  url: URL,
  env: Env,
  requestId: string,
  injectedDeps?: McpWorkerDeps,
): Promise<Response> {
  if (url.pathname === "/health" && request.method === "GET") {
    return handleHealth(env, requestId);
  }

  // MCP3 ships RFC 9728 protected-resource metadata here; 404 until then
  // (the 401 WWW-Authenticate challenge already names this path).
  if (url.pathname === "/.well-known/oauth-protected-resource") {
    return notFound(requestId, url.pathname);
  }

  if (url.pathname === "/mcp" || url.pathname === "/") {
    if (request.method !== "POST") {
      // Stateless server: no GET/SSE stream, no DELETE session termination
      // (both permitted by the Streamable HTTP spec) — see handlers/mcp.ts.
      return methodNotAllowed(requestId);
    }
    if (inFlight >= MAX_CONCURRENT_REQUESTS) {
      return errorResponse("rate_limited", "Too many concurrent requests", 429, requestId, {
        "Retry-After": "1",
      });
    }
    inFlight++;
    try {
      return await handleMcpPost(request, env, injectedDeps ?? buildDeps(), requestId);
    } finally {
      inFlight--;
    }
  }

  return notFound(requestId, url.pathname);
}
