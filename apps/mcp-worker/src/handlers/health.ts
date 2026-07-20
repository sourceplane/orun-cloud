import { readOnlyTools, SERVER_NAME, SERVER_VERSION } from "@saas/mcp";

import type { Env } from "../env.js";
import { successResponse } from "../http.js";

/**
 * GET /health — liveness + the tool roster size the transport serves. The
 * remote transport is read-only (handlers/mcp.ts), so this counts the
 * read-only set, not the full registry with the MCP5 writes.
 */
export function handleHealth(env: Env, requestId: string): Response {
  return successResponse(
    {
      ok: true,
      service: "mcp-worker",
      name: SERVER_NAME,
      version: SERVER_VERSION,
      environment: env.ENVIRONMENT ?? "local",
      toolCount: readOnlyTools.length,
      checks: {
        apiEdgeUrl: { configured: !!env.API_EDGE_URL },
        // The service binding is how tool calls actually reach api-edge in
        // deployed envs (a sibling *.workers.dev fetch would bare-404). Absent
        // locally, where global fetch → local API_EDGE_URL is used instead.
        apiEdgeBinding: { bound: !!env.API_EDGE },
      },
    },
    requestId,
  );
}
