// Internal agent-session token mint (saas-agents AG6 §3.2).
//
// Service-binding-only: agents-worker calls this over its IDENTITY_WORKER
// binding to mint the short-TTL session credential injected at provision and
// re-minted on lease-gated refresh. api-edge never forwards /v1/internal/*,
// so no external caller can reach it. The lease gate itself lives in
// agents-worker (it owns the session row); this route only turns an already
// authorized (principal, org, session) triple into a signed bearer.

import type { Env } from "../env.js";
import { errorResponse, successResponse } from "../http.js";
import { mintAgentSessionToken } from "../cli/jwt.js";

const PRINCIPAL_RE = /^sp_[A-Za-z0-9_-]{1,64}$/;
const SESSION_RE = /^as_[A-Za-z0-9_-]{1,64}$/;
const ORG_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function handleMintAgentSessionToken(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }
  let body: { principalId?: string; orgId?: string; sessionId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse("validation_failed", "Invalid JSON", 422, requestId);
  }
  if (
    typeof body.principalId !== "string" ||
    !PRINCIPAL_RE.test(body.principalId) ||
    typeof body.orgId !== "string" ||
    !ORG_RE.test(body.orgId) ||
    typeof body.sessionId !== "string" ||
    !SESSION_RE.test(body.sessionId)
  ) {
    return errorResponse("validation_failed", "principalId (sp_…), orgId, sessionId (as_…) required", 422, requestId);
  }

  try {
    const minted = await mintAgentSessionToken(env, {
      principalId: body.principalId,
      orgId: body.orgId,
      sessionId: body.sessionId,
      now: new Date(),
    });
    return successResponse(
      { token: minted.token, expiresAt: minted.expiresAt.toISOString() },
      requestId,
      201,
    );
  } catch {
    // Signing key unset: misconfiguration, never a silent grant.
    return errorResponse("internal_error", "Token service is not configured", 503, requestId);
  }
}
