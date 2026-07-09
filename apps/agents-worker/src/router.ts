// agents-worker router. AG5 (dormant): /health only. AG6 adds the
// control-plane routes (profiles, sessions, the orun-agent-serve attach
// channel + per-session DO relay) behind the actor gate — every one re-entered
// through api-edge with the caller's credential, so RBAC/audit apply unchanged.

import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { errorResponse, notFound } from "./http.js";

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function generateRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }
    // Control-plane routes land in AG6; until then everything else is 404.
    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}
