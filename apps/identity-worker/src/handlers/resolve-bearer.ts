import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createIdentityRepository } from "@saas/db/identity";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, extractBearerToken, withTimings } from "../http.js";
import { createTimings } from "@saas/contracts/timing";
import {
  looksLikeCliAccessToken,
  verifyAgentSessionToken,
  verifyCliAccessToken,
  verifyWorkflowAccessToken,
} from "../cli/jwt.js";

export async function handleResolveBearer(request: Request, env: Env, requestId: string): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  }

  // CLI access JWT (OP1): verified locally against the Worker signing key — no DB
  // hop. A valid token resolves straight to a user ActorContext. (Revocation is
  // bounded by the short ~15m exp; refresh re-checks the session row.) If the
  // token looks like ours but fails verification, fall through to a 401 below.
  if (looksLikeCliAccessToken(token)) {
    const now = new Date();
    const claims = await verifyCliAccessToken(env, token, now);
    if (claims) {
      return successResponse(
        {
          actor: {
            actorType: "user",
            actorId: claims.sub,
            ...(claims.orgIds.length > 0 && { orgId: claims.orgIds[0] }),
          },
          session: { id: claims.sessionId },
          cliOrgIds: claims.orgIds,
        },
        requestId,
        200,
      );
    }
    // Same HS256 envelope, workflow actor (OV3): resolve to the bound
    // (org, project) ActorContext the state plane authorizes on.
    const wf = await verifyWorkflowAccessToken(env, token, now);
    if (wf) {
      return successResponse(
        {
          actor: {
            actorType: "workflow",
            actorId: wf.sub,
            orgId: wf.orgId,
            projectId: wf.projectId,
          },
        },
        requestId,
        200,
      );
    }
    // Same envelope, agent-session actor (saas-agents AG6 §3.2): resolve to
    // the profile's SERVICE PRINCIPAL — no new identity plane — with the
    // session id surfaced for audit and session-bound route gates.
    const ag = await verifyAgentSessionToken(env, token, now);
    if (ag) {
      return successResponse(
        {
          actor: {
            actorType: "service_principal",
            actorId: ag.sub,
            orgId: ag.orgId,
          },
          agentSession: { id: ag.sessionId },
        },
        requestId,
        200,
      );
    }
    return errorResponse("unauthenticated", "Invalid or expired CLI token", 401, requestId);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  // PERF14b: the `resolve` phase times the DB-backed resolution (a single
  // JOINed query since PERF12d) — the cost of every edge bearer-cache miss.
  const timings = createTimings();
  const endTotal = timings.start("total");
  const route = "identity.resolve";
  try {
    const repo = createIdentityRepository(executor);
    const auth = createAuthService({ repo, now: () => new Date() });
    const result = await timings.measure("resolve", () => auth.resolveBearer(token));
    endTotal();

    if ("error" in result) {
      return withTimings(errorResponse(result.error, result.message, 401, requestId), requestId, route, timings);
    }

    return withTimings(successResponse(
      {
        actor: {
          actorType: result.actorType,
          actorId: result.actorId,
          ...(result.orgId !== undefined && { orgId: result.orgId }),
          ...(result.projectId !== undefined && { projectId: result.projectId }),
          ...(result.displayName !== undefined && { displayName: result.displayName }),
          ...(result.email !== undefined && { email: result.email }),
        },
        ...(result.session && {
          session: {
            id: result.session.id,
            expiresAt: result.session.expiresAt.toISOString(),
            createdAt: result.session.createdAt.toISOString(),
          },
        }),
        ...(result.user && { user: result.user }),
      },
      requestId,
      200,
    ), requestId, route, timings);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await executor.dispose();
  }
}
