// brokered-orphan-safety (Feature 1): internal batch connection-status read.
//
// POST /internal/connections/status — service-binding-only (x-internal-caller),
// never edge-routed. config-worker calls this to stamp brokered secrets with
// their connection's live health so orphaned rows surface in every listing.
// Returns status keyed by the PUBLIC connection id (int_…); a connection that
// is not found is simply omitted (the caller reads that as "missing").

import type { Env } from "../env.js";
import { createIntegrationsRepository } from "@saas/db/integrations";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import { errorResponse, successResponse } from "../http.js";
import { parseConnectionPublicId } from "../ids.js";

const MAX_IDS = 200;

export async function handleInternalConnectionStatuses(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }
  let body: { connectionIds?: unknown };
  try {
    body = (await request.json()) as { connectionIds?: unknown };
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const ids = Array.isArray(body.connectionIds)
    ? body.connectionIds.filter((x): x is string => typeof x === "string").slice(0, MAX_IDS)
    : [];

  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createIntegrationsRepository(executor);
  const statuses: Record<string, string> = {};
  for (const publicId of ids) {
    const uuid = parseConnectionPublicId(publicId);
    if (!uuid) continue;
    const conn = await repo.getConnectionById(asUuid(uuid));
    if (conn.ok) statuses[publicId] = conn.value.status;
  }
  return successResponse({ statuses }, requestId);
}
