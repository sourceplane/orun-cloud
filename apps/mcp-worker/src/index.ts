// mcp-worker — the remote MCP transport (saas-mcp-server MCP2, design §2).
//
// One tool plane, two transports: `packages/mcp` owns the registry/schemas/
// handlers; this worker adds ONLY transport concerns — Streamable HTTP framing
// (stateless, risk D5), bearer pass-through, a per-isolate concurrency cap,
// health, and request logs. It is a CLIENT of the platform: no service
// bindings, no DB, no policy logic; every tool call re-enters api-edge as an
// authenticated HTTP request carrying the caller's own credential.

import type { Env } from "./env.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ctx rides along so the MCP6 usage ingest can be waitUntil-scheduled —
    // fire-and-forget metering must outlive the response without blocking it.
    return route(request, env, undefined, ctx);
  },
} satisfies ExportedHandler<Env>;
