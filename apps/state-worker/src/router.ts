import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import {
  handleCreateWorkspaceLink,
  handleListWorkspaceLinks,
  handleResolveWorkspaceLinks,
  handleUnlinkWorkspaceLink,
} from "./handlers/links.js";
import {
  handleCancelRun,
  handleClaimJob,
  handleCreateRun,
  handleGetRun,
  handleHeartbeatJob,
  handleListJobs,
  handleListRuns,
  handleRunnableJobs,
  handleUpdateJob,
} from "./handlers/runs.js";
import { handleAppendLog, handleReadLog } from "./handlers/logs.js";
import {
  generateRequestId,
  isRunUlid,
  parseOrgPublicId,
  parseProjectPublicId,
  parseWorkspaceLinkPublicId,
} from "./ids.js";
import { asUuid } from "@saas/db/ids";
import { enforceContractVersion } from "./contract-version.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";

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

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

// OP4 — Tenancy resolution & workspace links (state-api-contract §5).
const ORG_CLI_LINKS_RE = /^\/v1\/organizations\/([^/]+)\/cli\/links$/;
const CLI_LINKS_RESOLVE_PATH = "/v1/cli/links/resolve";
// Console-management surface (list + unlink) for the project Settings → CLI
// page. Org/project-scoped; not part of the CLI contract but the same owner.
const ORG_PROJECT_CLI_LINKS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/cli\/links$/;
const ORG_PROJECT_CLI_LINK_RE =
  /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/cli\/links\/([^/]+)$/;

// OP2 — Run coordination plane (state-api-contract §2). All path-scoped under
// /v1/organizations/{orgId}/projects/{projectId}/state.
const STATE_BASE = "/v1/organizations/([^/]+)/projects/([^/]+)/state";
const RUNS_RE = new RegExp(`^${STATE_BASE}/runs$`);
const RUN_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)$`);
const RUN_JOBS_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/jobs$`);
const RUN_RUNNABLE_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/runnable$`);
const RUN_CANCEL_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/cancel$`);
const RUN_JOB_CLAIM_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/jobs/([^/]+)/claim$`);
const RUN_JOB_HEARTBEAT_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/jobs/([^/]+)/heartbeat$`);
const RUN_JOB_UPDATE_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/jobs/([^/]+)/update$`);
const RUN_LOGS_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/logs/([^/]+)$`);

export async function route(request: Request, env: Env): Promise<Response> {
  const requestId = resolveRequestId(request);
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Health check — no auth required.
  if (pathname === "/health") {
    return handleHealth(env, requestId);
  }

  // OP2/OP3 (run coordination §2, object/log plane §3, catalog heads §3.1) stay
  // dormant — those routes land in later milestones. OP4 brings the workspace-
  // link surface (§5) live behind the api-edge state-facade + actor headers.

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const actor = resolveActor(request);
  if (!actor) {
    return errorResponse("unauthenticated", "Authentication required", 401, requestId);
  }

  // GET /v1/cli/links/resolve?remoteUrl= — org-independent picker.
  if (pathname === CLI_LINKS_RESOLVE_PATH) {
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleResolveWorkspaceLinks(request, env, requestId, actor);
  }

  // POST /v1/organizations/{orgId}/cli/links — create (policy org.cli.link).
  let m = pathname.match(ORG_CLI_LINKS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleCreateWorkspaceLink(request, env, requestId, actor, orgId);
  }

  // GET .../projects/{projectId}/cli/links — console list.
  m = pathname.match(ORG_PROJECT_CLI_LINKS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListWorkspaceLinks(request, env, requestId, actor, orgId, projectId);
  }

  // DELETE .../projects/{projectId}/cli/links/{linkId} — console unlink.
  m = pathname.match(ORG_PROJECT_CLI_LINK_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    const linkId = parseWorkspaceLinkPublicId(m[3]!);
    if (!orgId || !projectId || !linkId) return notFound(requestId, pathname);
    if (request.method !== "DELETE") return methodNotAllowed(requestId);
    return handleUnlinkWorkspaceLink(env, requestId, actor, orgId, projectId, asUuid(linkId));
  }

  // ── OP2 — Run coordination plane (§2). ──
  // Every run route enforces Orun-Contract-Version before any work.
  if (pathname.includes("/state/")) {
    const versionError = enforceContractVersion(request, requestId);
    if (versionError) return versionError;
    const runResponse = await routeRun(request, env, requestId, actor, pathname);
    if (runResponse) return runResponse;
  }

  return notFound(requestId, pathname);
}

/**
 * Dispatch the run-coordination routes (state-api-contract §2). Returns a
 * Response when a route matches, or null so the caller falls through to 404.
 * Scope parse failures 404 (resource-hiding); the run ULID is validated here so
 * a malformed id never reaches the repo.
 */
async function routeRun(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  pathname: string,
): Promise<Response | null> {
  // POST/GET …/state/runs
  let m = pathname.match(RUNS_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method === "POST") {
      return handleCreateRun(request, env, requestId, actor, scope.orgId, scope.projectId);
    }
    if (request.method === "GET") {
      return handleListRuns(request, env, requestId, actor, scope.orgId, scope.projectId);
    }
    return methodNotAllowed(requestId);
  }

  // POST …/runs/{runId}/jobs/{jobId}/claim
  m = pathname.match(RUN_JOB_CLAIM_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleClaimJob(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!, m[4]!);
  }

  // POST …/runs/{runId}/jobs/{jobId}/heartbeat
  m = pathname.match(RUN_JOB_HEARTBEAT_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleHeartbeatJob(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!, m[4]!);
  }

  // POST …/runs/{runId}/jobs/{jobId}/update
  m = pathname.match(RUN_JOB_UPDATE_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleUpdateJob(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!, m[4]!);
  }

  // GET …/runs/{runId}/jobs
  m = pathname.match(RUN_JOBS_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListJobs(env, requestId, actor, scope.orgId, scope.projectId, m[3]!);
  }

  // GET …/runs/{runId}/runnable
  m = pathname.match(RUN_RUNNABLE_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleRunnableJobs(env, requestId, actor, scope.orgId, scope.projectId, m[3]!);
  }

  // POST …/runs/{runId}/cancel
  m = pathname.match(RUN_CANCEL_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleCancelRun(env, requestId, actor, scope.orgId, scope.projectId, m[3]!);
  }

  // POST/GET …/runs/{runId}/logs/{jobId} — deferred to OP3 (clear 501).
  m = pathname.match(RUN_LOGS_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method === "POST") {
      return handleAppendLog(env, requestId, actor, scope.orgId, scope.projectId);
    }
    if (request.method === "GET") {
      return handleReadLog(env, requestId, actor, scope.orgId, scope.projectId);
    }
    return methodNotAllowed(requestId);
  }

  // GET …/runs/{runId} — must be matched LAST among /runs/{x} (greedy guards
  // above already consumed the sub-resources). Validate the ULID here.
  m = pathname.match(RUN_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleGetRun(env, requestId, actor, scope.orgId, scope.projectId, m[3]!);
  }

  return null;
}

function parseScope(orgPublic: string, projectPublic: string): { orgId: ReturnType<typeof asUuid>; projectId: ReturnType<typeof asUuid> } | null {
  const orgId = parseOrgPublicId(orgPublic);
  const projectId = parseProjectPublicId(projectPublic);
  if (!orgId || !projectId) return null;
  return { orgId, projectId };
}
