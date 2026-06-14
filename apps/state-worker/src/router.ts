import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { generateRequestId } from "./ids.js";
import { notFound } from "./http.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

export async function route(request: Request, env: Env): Promise<Response> {
  const requestId = resolveRequestId(request);
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Health check — no auth required.
  if (pathname === "/health") {
    return handleHealth(env, requestId);
  }

  // OP0 is dormant: the state surface (run coordination §2, object/log plane
  // §3, catalog heads §3.1, workspace links §5 of state-api-contract.md) is
  // schema- and contract-complete but has no live route. Routes land at OP2+
  // behind the api-edge state-facade + service binding, gated by the
  // deny-by-default state.* policy actions. Until then everything but /health
  // is a clean 404 — no public route is reachable.
  return notFound(requestId, pathname);
}
