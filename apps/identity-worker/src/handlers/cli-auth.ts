import type { Env } from "../env.js";
import type { IdentityRepository, CliLoginGrant, Session } from "@saas/db/identity";
import type {
  CliSessionPayload,
  CliSessionSummary,
  CliGrantView,
} from "@saas/contracts/auth";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createIdentityRepository } from "@saas/db/identity";
import { createCliAuthService, type CliError } from "../services/cli-auth.js";
import { fetchSubjectOrgs } from "../membership-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { extractRequestContext } from "../request-context.js";
import { cliGrantPublicId, cliSessionPublicId } from "../cli/secrets.js";
import { parseSubjectUuid } from "../ids.js";

export interface CliAuthDeps {
  repo?: IdentityRepository;
  fetchOrgs?: (subjectId: string) => Promise<CliSessionPayload["orgs"]>;
}

interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function extractActorFromHeaders(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

const STATUS_MAP: Record<CliError["error"], number> = {
  invalid_request: 400,
  not_found: 404,
  expired: 410,
  signing_unavailable: 503,
  internal_error: 503,
};

function cliErrorResponse(err: CliError, requestId: string): Response {
  // For refresh/redeem failures we want a stable 401 so the CLI re-logs in,
  // except service-config (503) and validation (400/410). `not_found` on the
  // token paths means "no longer valid" → unauthenticated.
  const status = err.error === "not_found" ? 401 : STATUS_MAP[err.error];
  const code =
    err.error === "not_found"
      ? "unauthenticated"
      : err.error === "signing_unavailable" || err.error === "internal_error"
        ? "internal_error"
        : err.error === "expired"
          ? "expired"
          : "validation_failed";
  return errorResponse(code, err.message, status, requestId);
}

// Shared with handlers/oauth2.ts (MCP3) — the OAuth endpoints construct the
// SAME OP1 service over the same repo/orgs wiring (risks R5: one issuance path).
export function makeService(env: Env, request: Request, requestId: string, deps: CliAuthDeps | undefined, repo: IdentityRepository) {
  const ctx = extractRequestContext(request, requestId);
  const fetchOrgs =
    deps?.fetchOrgs ??
    (async (subjectId: string) => {
      if (!env.MEMBERSHIP_WORKER) return [];
      const r = await fetchSubjectOrgs(env.MEMBERSHIP_WORKER, subjectId, "user", requestId);
      return r.ok ? r.orgs : [];
    });
  return createCliAuthService({ repo, env, now: () => new Date(), ctx, fetchOrgs });
}

async function readBody(request: Request, requestId: string): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Empty bodies are allowed for start/device-start.
    if (request.headers.get("content-length") === "0") return {};
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (body === null || body === undefined) return {};
  if (typeof body !== "object") return validationError(requestId, { body: ["Request body must be an object"] });
  return body as Record<string, unknown>;
}

function grantView(grant: CliLoginGrant, publicId: string): CliGrantView {
  return {
    id: publicId,
    flow: grant.flow,
    host: grant.clientHost,
    status: grant.status,
    expiresAt: grant.expiresAt.toISOString(),
  };
}

function sessionSummary(s: Session): CliSessionSummary {
  return {
    id: cliSessionPublicId(s.id),
    host: s.clientHost,
    createdAt: s.createdAt.toISOString(),
    lastUsedAt: s.lastSeenAt.toISOString(),
    expiresAt: (s.refreshExpiresAt ?? s.expiresAt).toISOString(),
    revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
  };
}

export async function withRepo<T>(
  env: Env,
  deps: CliAuthDeps | undefined,
  fn: (repo: IdentityRepository) => Promise<T>,
): Promise<T | Response> {
  if (deps?.repo) return fn(deps.repo);
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, "no-db");
  }
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    return await fn(createIdentityRepository(executor));
  } finally {
    await executor.dispose();
  }
}

// ---------------------------------------------------------------------------
// POST /v1/auth/cli/start  (browser loopback)
// ---------------------------------------------------------------------------

export async function handleCliStart(request: Request, env: Env, requestId: string, deps?: CliAuthDeps): Promise<Response> {
  const body = await readBody(request, requestId);
  if (body instanceof Response) return body;
  const host = typeof body.host === "string" ? body.host.slice(0, 128) : null;

  const result = await withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    const r = await svc.start(host);
    if ("error" in r) return cliErrorResponse(r, requestId);
    return successResponse(
      { authorizeUrl: r.authorizeUrl, cliCode: r.cliCode, expiresAt: r.expiresAt.toISOString() },
      requestId,
      201,
    );
  });
  return result;
}

// ---------------------------------------------------------------------------
// POST /v1/auth/cli/device/start
// ---------------------------------------------------------------------------

export async function handleCliDeviceStart(request: Request, env: Env, requestId: string, deps?: CliAuthDeps): Promise<Response> {
  const body = await readBody(request, requestId);
  if (body instanceof Response) return body;
  const host = typeof body.host === "string" ? body.host.slice(0, 128) : null;

  return withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    const r = await svc.deviceStart(host);
    if ("error" in r) return cliErrorResponse(r, requestId);
    return successResponse(
      {
        deviceCode: r.deviceCode,
        userCode: r.userCode,
        verificationUrl: r.verificationUrl,
        interval: r.interval,
        expiresAt: r.expiresAt.toISOString(),
      },
      requestId,
      201,
    );
  });
}

// ---------------------------------------------------------------------------
// POST /v1/auth/cli/device/poll
// ---------------------------------------------------------------------------

export async function handleCliDevicePoll(request: Request, env: Env, requestId: string, deps?: CliAuthDeps): Promise<Response> {
  const body = await readBody(request, requestId);
  if (body instanceof Response) return body;
  if (typeof body.deviceCode !== "string" || !body.deviceCode) {
    return validationError(requestId, { deviceCode: ["Required"] });
  }
  const deviceCode = body.deviceCode;

  return withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    const r = await svc.devicePoll(deviceCode);
    if ("error" in r) return cliErrorResponse(r, requestId);
    if (r.kind === "complete") {
      return successResponse({ status: "complete", session: r.session }, requestId, 200);
    }
    if (r.kind === "denied") {
      // RFC-8628 terminal error: the user rejected the device.
      return errorResponse("access_denied", "Device authorization was denied", 403, requestId);
    }
    if (r.kind === "expired") {
      return errorResponse("expired", "Device code expired", 410, requestId);
    }
    // pending
    return successResponse({ status: "pending", error: "authorization_pending" }, requestId, 200);
  });
}

// ---------------------------------------------------------------------------
// POST /v1/auth/cli/token  (grant redeem OR rotating refresh)
// ---------------------------------------------------------------------------

export async function handleCliToken(request: Request, env: Env, requestId: string, deps?: CliAuthDeps): Promise<Response> {
  const body = await readBody(request, requestId);
  if (body instanceof Response) return body;
  const grantType = body.grantType;
  if (grantType !== "cli_code" && grantType !== "refresh_token") {
    return validationError(requestId, { grantType: ["Must be 'cli_code' or 'refresh_token'"] });
  }

  return withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    if (grantType === "cli_code") {
      if (typeof body.cliCode !== "string" || !body.cliCode) {
        return validationError(requestId, { cliCode: ["Required"] });
      }
      const r = await svc.redeemCliCode(body.cliCode);
      if ("error" in r) return cliErrorResponse(r, requestId);
      return successResponse(r, requestId, 200);
    }
    if (typeof body.refreshToken !== "string" || !body.refreshToken) {
      return validationError(requestId, { refreshToken: ["Required"] });
    }
    const r = await svc.refresh(body.refreshToken);
    if ("error" in r) return cliErrorResponse(r, requestId);
    return successResponse(r, requestId, 200);
  });
}

// ---------------------------------------------------------------------------
// POST /v1/auth/cli/revoke
// ---------------------------------------------------------------------------

export async function handleCliRevoke(request: Request, env: Env, requestId: string, deps?: CliAuthDeps): Promise<Response> {
  const body = await readBody(request, requestId);
  if (body instanceof Response) return body;
  if (typeof body.refreshToken !== "string" || !body.refreshToken) {
    return validationError(requestId, { refreshToken: ["Required"] });
  }
  const refreshToken = body.refreshToken;

  return withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    const r = await svc.revoke(refreshToken);
    if ("error" in r) return cliErrorResponse(r, requestId);
    return successResponse({ success: true }, requestId, 200);
  });
}

// ---------------------------------------------------------------------------
// Console-side grant management (authenticated user, forwarded from api-edge).
// GET  /v1/auth/cli/grants/{grantId}?userCode=
// POST /v1/auth/cli/grants/{grantId}/approve
// POST /v1/auth/cli/grants/{grantId}/deny
// ---------------------------------------------------------------------------

function extractGrantId(pathname: string): string | null {
  const m = pathname.match(/^\/v1\/auth\/cli\/grants\/([^/]+)(?:\/(approve|deny))?$/);
  return m ? m[1]! : null;
}

export async function handleCliGetGrant(request: Request, env: Env, requestId: string, deps?: CliAuthDeps): Promise<Response> {
  const url = new URL(request.url);
  const grantId = extractGrantId(url.pathname);
  const userCode = url.searchParams.get("userCode") ?? undefined;
  if (!grantId && !userCode) return validationError(requestId, { grant: ["Required"] });

  return withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    const r = await svc.getGrant(userCode ? { userCode } : { grantId: grantId! });
    if ("error" in r) return cliErrorResponse(r, requestId);
    return successResponse({ grant: grantView(r.grant, r.publicId) }, requestId, 200);
  });
}

export async function handleCliApproveGrant(request: Request, env: Env, requestId: string, deps?: CliAuthDeps): Promise<Response> {
  const actor = extractActorFromHeaders(request);
  if (!actor) return errorResponse("unauthorized", "Unauthorized", 401, requestId);
  const actorUuid = parseSubjectUuid(actor.subjectId);
  if (!actorUuid || actor.subjectType !== "user") {
    return errorResponse("forbidden", "Only users can approve CLI logins", 403, requestId);
  }
  const url = new URL(request.url);
  // Body may carry a userCode (device flow approval entered by the human).
  const body = await readBody(request, requestId);
  if (body instanceof Response) return body;

  return withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    // Resolve the grant id: from the path, or from a userCode in the body.
    let publicGrantId = extractGrantId(url.pathname);
    if ((!publicGrantId || publicGrantId === "by-code") && typeof body.userCode === "string") {
      const lookup = await svc.getGrant({ userCode: body.userCode });
      if ("error" in lookup) return cliErrorResponse(lookup, requestId);
      publicGrantId = lookup.publicId;
    }
    if (!publicGrantId) return validationError(requestId, { grant: ["Required"] });

    const r = await svc.approveGrant(publicGrantId, actorUuid);
    if ("error" in r) return cliErrorResponse(r, requestId);
    return successResponse(
      { grant: { id: r.publicId, flow: r.flow, host: r.host, status: r.status, expiresAt: "" } },
      requestId,
      200,
    );
  });
}

export async function handleCliDenyGrant(request: Request, env: Env, requestId: string, deps?: CliAuthDeps): Promise<Response> {
  const actor = extractActorFromHeaders(request);
  if (!actor) return errorResponse("unauthorized", "Unauthorized", 401, requestId);
  const actorUuid = parseSubjectUuid(actor.subjectId);
  if (!actorUuid || actor.subjectType !== "user") {
    return errorResponse("forbidden", "Only users can deny CLI logins", 403, requestId);
  }
  const url = new URL(request.url);
  const body = await readBody(request, requestId);
  if (body instanceof Response) return body;

  return withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    let publicGrantId = extractGrantId(url.pathname);
    if ((!publicGrantId || publicGrantId === "by-code") && typeof body.userCode === "string") {
      const lookup = await svc.getGrant({ userCode: body.userCode });
      if ("error" in lookup) return cliErrorResponse(lookup, requestId);
      publicGrantId = lookup.publicId;
    }
    if (!publicGrantId) return validationError(requestId, { grant: ["Required"] });

    const r = await svc.denyGrant(publicGrantId, actorUuid);
    if ("error" in r) return cliErrorResponse(r, requestId);
    return successResponse(
      { grant: { id: r.publicId, flow: r.flow, host: r.host, status: r.status, expiresAt: "" } },
      requestId,
      200,
    );
  });
}

// ---------------------------------------------------------------------------
// Console "Sessions & devices" (authenticated user).
// GET    /v1/auth/cli/sessions
// DELETE /v1/auth/cli/sessions/{sessionId}
// ---------------------------------------------------------------------------

export async function handleCliListSessions(request: Request, env: Env, requestId: string, deps?: CliAuthDeps): Promise<Response> {
  const actor = extractActorFromHeaders(request);
  if (!actor) return errorResponse("unauthorized", "Unauthorized", 401, requestId);
  const actorUuid = parseSubjectUuid(actor.subjectId);
  if (!actorUuid || actor.subjectType !== "user") {
    return errorResponse("forbidden", "Only users have CLI sessions", 403, requestId);
  }

  return withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    const r = await svc.listSessions(actorUuid);
    if (!Array.isArray(r)) return cliErrorResponse(r, requestId);
    return successResponse({ sessions: r.map(sessionSummary) }, requestId, 200);
  });
}

export async function handleCliRevokeSession(request: Request, env: Env, requestId: string, deps?: CliAuthDeps): Promise<Response> {
  const actor = extractActorFromHeaders(request);
  if (!actor) return errorResponse("unauthorized", "Unauthorized", 401, requestId);
  const actorUuid = parseSubjectUuid(actor.subjectId);
  if (!actorUuid || actor.subjectType !== "user") {
    return errorResponse("forbidden", "Only users have CLI sessions", 403, requestId);
  }
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/v1\/auth\/cli\/sessions\/([^/]+)$/);
  if (!m) return validationError(requestId, { sessionId: ["Required"] });
  const sessionId = m[1]!;

  return withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    const r = await svc.revokeSessionById(actorUuid, sessionId);
    if ("error" in r) return cliErrorResponse(r, requestId);
    return successResponse({ session: sessionSummary(r) }, requestId, 200);
  });
}

// Re-export for router static analysis convenience.
export { cliGrantPublicId };
