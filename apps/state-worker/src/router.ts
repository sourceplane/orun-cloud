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
  handleObjectsMissing,
  handlePutObject,
  handleGetObject,
  handleListObjects,
  handleStartUpload,
  handleUploadPart,
  handleCompleteUpload,
} from "./handlers/objects.js";
import {
  handleAdvanceCatalogHead,
  handleGetCatalogHead,
  handleCatalogHeadHistory,
  handleListCatalogEntities,
} from "./handlers/catalog.js";
import {
  handleGetRef,
  handleUpdateRef,
  handleListRefs,
  handleDeleteRef,
} from "./handlers/refs.js";
import {
  generateRequestId,
  isRunUlid,
  parseOrgPublicId,
  parseProjectPublicId,
  parseWorkspaceLinkPublicId,
} from "./ids.js";
import { asUuid, type Uuid } from "@saas/db/ids";
import { enforceContractVersion } from "./contract-version.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
  /** Workflow actors (OV3) carry their token-bound (org, project) as UUIDs; the
   *  OIDC token is the authorization, so authorizeRun grants within this scope
   *  without a role lookup. Undefined for user / service_principal actors. */
  boundOrgId?: Uuid;
  boundProjectId?: Uuid;
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
  const actor: ActorContext = { subjectId, subjectType };
  // Bound scope for workflow actors (OV3). The edge forwards public ids; parse
  // to UUIDs so authorizeRun can compare against the path-scoped (org, project).
  const boundOrg = parseOrgPublicId(request.headers.get("x-actor-org-id") ?? "");
  const boundProject = parseProjectPublicId(request.headers.get("x-actor-project-id") ?? "");
  if (boundOrg) actor.boundOrgId = boundOrg;
  if (boundProject) actor.boundProjectId = boundProject;
  return actor;
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

// OP3 — Object & log plane (state-api-contract §3) + catalog heads (§3.1).
const OBJECTS_RE = new RegExp(`^${STATE_BASE}/objects$`);
const OBJECTS_MISSING_RE = new RegExp(`^${STATE_BASE}/objects/missing$`);
const OBJECT_RE = new RegExp(`^${STATE_BASE}/objects/(sha256:[0-9a-f]{64})$`);
const OBJECT_UPLOADS_RE = new RegExp(`^${STATE_BASE}/objects/(sha256:[0-9a-f]{64})/uploads$`);
const OBJECT_UPLOAD_PART_RE = new RegExp(
  `^${STATE_BASE}/objects/(sha256:[0-9a-f]{64})/uploads/([^/]+)/parts/([0-9]+)$`,
);
const OBJECT_UPLOAD_COMPLETE_RE = new RegExp(
  `^${STATE_BASE}/objects/(sha256:[0-9a-f]{64})/uploads/([^/]+)/complete$`,
);
const CATALOG_HEAD_RE = new RegExp(`^${STATE_BASE}/catalog/head$`);
const CATALOG_HEADS_HISTORY_RE = new RegExp(`^${STATE_BASE}/catalog/heads/history$`);
const CATALOG_ENTITIES_RE = new RegExp(`^${STATE_BASE}/catalog/entities$`);

// OV1 — hosted RefStore (design-v2 §2). Ref names carry slashes
// (catalogs/current, executions/by-id/<id>), so the name is a greedy tail.
const REFS_RE = new RegExp(`^${STATE_BASE}/refs$`);
const REF_RE = new RegExp(`^${STATE_BASE}/refs/(.+)$`);

export async function route(request: Request, env: Env): Promise<Response> {
  const requestId = resolveRequestId(request);
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Health check — no auth required.
  if (pathname === "/health") {
    return handleHealth(env, requestId);
  }

  // OP2 (run coordination §2), OP3 (object/log plane §3, catalog heads §3.1), and
  // OP4 (workspace links §5) are all live behind the api-edge state-facade +
  // actor headers. The catalog entity read-model (§3.1 entities) is the only
  // deferred surface (OP7) — its route returns a clear 501.

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
  // ── OP3 — Object & log plane (§3) + catalog heads (§3.1). ──
  const objectOrCatalog = await routeObjectAndCatalog(request, env, requestId, actor, pathname);
  if (objectOrCatalog) return objectOrCatalog;

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

  // POST/GET …/runs/{runId}/logs/{jobId} (OP3 — §2.3).
  m = pathname.match(RUN_LOGS_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method === "POST") {
      return handleAppendLog(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!, m[4]!);
    }
    if (request.method === "GET") {
      return handleReadLog(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!, m[4]!);
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

/**
 * Dispatch the object plane (§3) and catalog heads (§3.1). Returns a Response on
 * a match, or null so routeRun falls through to the run matchers. The `objects/`
 * sub-routes are ordered most-specific first (missing, uploads, parts, complete)
 * so the bare-digest GET/PUT matches last.
 */
async function routeObjectAndCatalog(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  pathname: string,
): Promise<Response | null> {
  // POST …/state/objects/missing — digest negotiation.
  let m = pathname.match(OBJECTS_MISSING_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleObjectsMissing(request, env, requestId, actor, scope.orgId, scope.projectId);
  }

  // POST …/objects/{digest}/uploads — start a chunked (multipart) upload.
  m = pathname.match(OBJECT_UPLOADS_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleStartUpload(env, requestId, actor, scope.orgId, scope.projectId, m[3]!);
  }

  // PUT …/objects/{digest}/uploads/{uploadId}/parts/{n} — upload one part.
  m = pathname.match(OBJECT_UPLOAD_PART_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "PUT") return methodNotAllowed(requestId);
    const partNumber = Number.parseInt(m[5]!, 10);
    return handleUploadPart(
      request,
      env,
      requestId,
      actor,
      scope.orgId,
      scope.projectId,
      m[3]!,
      m[4]!,
      partNumber,
    );
  }

  // POST …/objects/{digest}/uploads/{uploadId}/complete — assemble + verify.
  m = pathname.match(OBJECT_UPLOAD_COMPLETE_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleCompleteUpload(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!, m[4]!);
  }

  // GET …/state/objects?kind=&cursor= — index listing.
  m = pathname.match(OBJECTS_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListObjects(request, env, requestId, actor, scope.orgId, scope.projectId);
  }

  // PUT/GET …/state/objects/{digest} — digest-verified PUT / blob GET.
  m = pathname.match(OBJECT_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method === "PUT") {
      return handlePutObject(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!);
    }
    if (request.method === "GET") {
      return handleGetObject(env, requestId, actor, scope.orgId, scope.projectId, m[3]!);
    }
    return methodNotAllowed(requestId);
  }

  // PUT/GET …/state/catalog/head — advance / current head.
  m = pathname.match(CATALOG_HEAD_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method === "PUT") {
      return handleAdvanceCatalogHead(request, env, requestId, actor, scope.orgId, scope.projectId);
    }
    if (request.method === "GET") {
      return handleGetCatalogHead(request, env, requestId, actor, scope.orgId, scope.projectId);
    }
    return methodNotAllowed(requestId);
  }

  // GET …/state/catalog/heads/history?cursor= — advance history.
  m = pathname.match(CATALOG_HEADS_HISTORY_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleCatalogHeadHistory(request, env, requestId, actor, scope.orgId, scope.projectId);
  }

  // GET …/state/catalog/entities — DEFERRED to OP7 (clear 501).
  m = pathname.match(CATALOG_ENTITIES_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListCatalogEntities(env, requestId, actor, scope.orgId, scope.projectId);
  }

  // ── OV1 — hosted RefStore (§2). The list route (…/refs) must precede the
  // single-ref tail (…/refs/<name>) so the bare collection isn't captured as a
  // name. ──

  // GET …/state/refs?prefix= — list ref names under a prefix.
  m = pathname.match(REFS_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListRefs(request, env, requestId, actor, scope.orgId, scope.projectId);
  }

  // GET/PUT/DELETE …/state/refs/{name} — resolve / compare-and-swap / remove.
  m = pathname.match(REF_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    const name = m[3]!;
    if (request.method === "GET") {
      return handleGetRef(env, requestId, actor, scope.orgId, scope.projectId, name);
    }
    if (request.method === "PUT") {
      return handleUpdateRef(request, env, requestId, actor, scope.orgId, scope.projectId, name);
    }
    if (request.method === "DELETE") {
      return handleDeleteRef(env, requestId, actor, scope.orgId, scope.projectId, name);
    }
    return methodNotAllowed(requestId);
  }

  return null;
}

function parseScope(orgPublic: string, projectPublic: string): { orgId: ReturnType<typeof asUuid>; projectId: ReturnType<typeof asUuid> } | null {
  const orgId = parseOrgPublicId(orgPublic);
  const projectId = parseProjectPublicId(projectPublic);
  if (!orgId || !projectId) return null;
  return { orgId, projectId };
}
