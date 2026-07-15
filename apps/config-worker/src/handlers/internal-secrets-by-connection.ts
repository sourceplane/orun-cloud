// brokered-orphan-safety (Feature 2): internal reverse lookup.
//
// POST /v1/internal/config/secrets/by-connection — reachable ONLY over a
// service binding (integrations-worker → config-worker); api-edge never
// forwards /v1/internal/*. Returns the ACTIVE brokered secrets still bound to a
// connection, so the connection-revoke guard can block (or, on force, report
// the casualties). Metadata only — never a secret value.

import type { Env } from "../env.js";
import { createConfigRepository } from "@saas/db/config";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { errorResponse, successResponse } from "../http.js";
import { toPublicSecretMetadata } from "../mappers.js";

const CONNECTION_ID_RE = /^int_[0-9a-f]{32}$/;

export async function handleInternalSecretsByConnection(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  let body: { connectionId?: unknown };
  try {
    body = (await request.json()) as { connectionId?: unknown };
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  if (!CONNECTION_ID_RE.test(connectionId)) {
    return errorResponse("bad_request", "connectionId (int_…) required", 400, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createConfigRepository(executor);
  const result = await repo.listActiveBrokeredSecretsByConnection(connectionId);
  if (!result.ok) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  return successResponse({ secrets: result.value.map(toPublicSecretMetadata) }, requestId);
}
