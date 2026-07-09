import { allTools, SERVER_NAME, SERVER_VERSION } from "@saas/mcp";

import type { Env } from "../env.js";
import { successResponse } from "../http.js";

/** GET /health — liveness + the tool roster size the transport serves. */
export function handleHealth(env: Env, requestId: string): Response {
  return successResponse(
    {
      ok: true,
      service: "mcp-worker",
      name: SERVER_NAME,
      version: SERVER_VERSION,
      environment: env.ENVIRONMENT ?? "local",
      toolCount: allTools.length,
      checks: {
        apiEdgeUrl: { configured: !!env.API_EDGE_URL },
      },
    },
    requestId,
  );
}
