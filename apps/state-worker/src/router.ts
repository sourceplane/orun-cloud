import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import {
  handleCreateWorkspaceLink,
  handleListWorkspaceLinks,
  handleListOrgWorkspaceLinks,
  handleResolveWorkspaceLinks,
  handleUnlinkWorkspaceLink,
} from "./handlers/links.js";
import {
  handleCreateRun,
  handleGetRun,
  handleListJobs,
  handleListRuns,
  handleListOrgRuns,
  handleRunnableJobs,
} from "./handlers/runs.js";
import { handleAppendLog, handleReadLog } from "./handlers/logs.js";
import {
  handleNativeCancel,
  handleNativeClaim,
  handleNativeComplete,
  handleNativeFrontier,
  handleNativeHeartbeat,
  handleNativeLog,
} from "./coordination-native.js";
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
  handleReprojectCatalogHead,
  handleCatalogHeadHistory,
  handleListCatalogEntities,
  handleListOrgCatalogEntities,
} from "./handlers/catalog.js";
import {
  handleListOrgRepoFacets,
  handleGetOrgRepoFacet,
  handleGetOrgCatalogDoc,
  handleListOrgCatalogDocs,
} from "./handlers/repo-facets.js";
import {
  handleCreateWorkSpec,
  handleCreateWorkTask,
  handleCreateWorkInitiative,
  handleEditWorkItem,
  handleWorkReaction,
  handleWorkTimeline,
  handleGetWorkDoc,
  handleListWorkEvents,
  handlePutWorkDoc,
  handleStreamWorkEvents,
  handleWorkDocHistory,
  handleIngestWorkObservation,
  handleWorkImport,
  handleWorkSummary,
  handleWorkTaskAction,
  handleSaveWorkView,
  handleListWorkViews,
  handleCreateWorkCycle,
  handleListWorkCycles,
  handleWorkBurnup,
  handleWorkTriage,
} from "./handlers/work.js";
import {
  handleGetWorkDesign,
  handleWorkApprove,
  handleWorkDesignDecision,
  handleWorkDesigns,
  handleWorkMilestones,
  handleWorkEpicBrief,
  handleWorkRegenerate,
  handleWorkReview,
  handleWorkRollups,
} from "./handlers/work-hierarchy.js";
import { handleGetOrgStateStorage } from "./handlers/state-usage.js";
import { handleGetStateGcReport } from "./handlers/gc-report.js";
import { handleCollectStateGc } from "./handlers/gc-collect.js";
import {
  handleGetRef,
  handleUpdateRef,
  handleListRefs,
  handleDeleteRef,
} from "./handlers/refs.js";
import { handleListTriggers } from "./handlers/triggers.js";
import { handleResolveRunSecrets } from "./handlers/secrets-resolve.js";
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
const RUN_LOGS_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/logs/([^/]+)$`);
// SM3 — the lease-bound secret resolve (state-api-contract §4). SLASH form
// (…/secrets/resolve), not a colon-verb; the ONLY value-returning machine route.
const RUN_SECRETS_RESOLVE_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/secrets/resolve$`);

// Native v2 coordination wire (coordination-api.md §2/§3) — colon-verbs + the
// run event-log/frontier reads, routed to the RunCoordinator DO. Disjoint from
// the OP2 slash-verb routes above (different path shape ⇒ no overlap).
const RUN_JOB_CLAIM_NATIVE_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/jobs/([^/:]+):claim$`);
const RUN_JOB_HEARTBEAT_NATIVE_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/jobs/([^/:]+):heartbeat$`);
const RUN_JOB_COMPLETE_NATIVE_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/jobs/([^/:]+):complete$`);
const RUN_CANCEL_NATIVE_RE = new RegExp(`^${STATE_BASE}/runs/([^/:]+):cancel$`);
const RUN_LOG_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/log$`);
const RUN_FRONTIER_RE = new RegExp(`^${STATE_BASE}/runs/([^/]+)/frontier$`);

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
const CATALOG_REPROJECT_RE = new RegExp(`^${STATE_BASE}/catalog/reproject$`);
const CATALOG_HEADS_HISTORY_RE = new RegExp(`^${STATE_BASE}/catalog/heads/history$`);
const CATALOG_ENTITIES_RE = new RegExp(`^${STATE_BASE}/catalog/entities$`);
// OV9 — object GC reachability report (report-only; no deletion).
const GC_REPORT_RE = new RegExp(`^${STATE_BASE}/gc/report$`);
// OV9 — object GC reclamation (the deleting path; safe-by-default, env-gated).
const GC_COLLECT_RE = new RegExp(`^${STATE_BASE}/gc/collect$`);
// OV6 — org-global catalog browser (no project scope): the default merged graph.
const ORG_CATALOG_ENTITIES_RE = /^\/v1\/organizations\/([^/]+)\/catalog\/entities$/;
// WO5 — repo self-description read model (org-scoped list + per-project get).
const ORG_REPO_FACETS_RE = /^\/v1\/organizations\/([^/]+)\/repo-facets$/;
const ORG_REPO_FACET_RE = /^\/v1\/organizations\/([^/]+)\/repo-facets\/([^/]+)$/;
// WO5 — console-facing overview doc read (org catalog-scoped, deframed; digest as
// a query param so its `sha256:` colon decodes normally).
const ORG_CATALOG_DOC_RE = /^\/v1\/organizations\/([^/]+)\/catalog\/doc$/;
// CD3 — the org-wide catalog doc index (the Docs hub browse). Disjoint from the
// singular /catalog/doc body read above.
const ORG_CATALOG_DOCS_RE = /^\/v1\/organizations\/([^/]+)\/catalog\/docs$/;
// OV9 — org state-plane storage footprint (no project scope): the STOCK gauge.
const ORG_STATE_USAGE_RE = /^\/v1\/organizations\/([^/]+)\/state\/usage$/;
// Org-global runs feed (no project scope): the console "Activities" surface, the
// merged run history across every project. Distinct from the project-scoped
// /projects/{id}/state/runs below (no project segment ⇒ disjoint paths).
const ORG_RUNS_RE = /^\/v1\/organizations\/([^/]+)\/state\/runs$/;

// orun-work v2 (WP1) — the work lens: fold query API + coordination mutators.
// Workspace-scoped (no project segment); lifecycle is derived on every read.
const ORG_WORK_RE = /^\/v1\/organizations\/([^/]+)\/work$/;
const ORG_WORK_EVENTS_RE = /^\/v1\/organizations\/([^/]+)\/work\/events$/;
const ORG_WORK_EVENTS_STREAM_RE = /^\/v1\/organizations\/([^/]+)\/work\/events\/stream$/;
const ORG_WORK_SPECS_RE = /^\/v1\/organizations\/([^/]+)\/work\/specs$/;
const ORG_WORK_INITIATIVES_RE = /^\/v1\/organizations\/([^/]+)\/work\/initiatives$/;
const ORG_WORK_TIMELINE_RE = /^\/v1\/organizations\/([^/]+)\/work\/timeline\/([^/]+)$/;
const ORG_WORK_REACTION_RE = /^\/v1\/organizations\/([^/]+)\/work\/comments\/([^/]+)\/reactions(\/remove)?$/;
const ORG_WORK_ITEM_EDIT_RE = /^\/v1\/organizations\/([^/]+)\/work\/items\/([^/]+)\/edit$/;
const ORG_WORK_SPEC_DOC_RE = /^\/v1\/organizations\/([^/]+)\/work\/specs\/([^/]+)\/doc$/;
const ORG_WORK_SPEC_DOC_HISTORY_RE = /^\/v1\/organizations\/([^/]+)\/work\/specs\/([^/]+)\/doc\/history$/;
const ORG_WORK_TASKS_RE = /^\/v1\/organizations\/([^/]+)\/work\/tasks$/;
const ORG_WORK_TASK_ACTION_RE = /^\/v1\/organizations\/([^/]+)\/work\/tasks\/([^/]+)\/(comment|assign|pin|cancel|contract|label|priority|estimate|relate|order|cycle|milestone)$/;
const ORG_WORK_VIEWS_RE = /^\/v1\/organizations\/([^/]+)\/work\/views$/;
const ORG_WORK_TRIAGE_RE = /^\/v1\/organizations\/([^/]+)\/work\/triage$/;
const ORG_WORK_CYCLES_RE = /^\/v1\/organizations\/([^/]+)\/work\/cycles$/;
const ORG_WORK_CYCLE_BURNUP_RE = /^\/v1\/organizations\/([^/]+)\/work\/cycles\/([^/]+)\/burnup$/;
const ORG_WORK_IMPORT_RE = /^\/v1\/organizations\/([^/]+)\/work\/import$/;
const ORG_WORK_OBSERVATIONS_RE = /^\/v1\/organizations\/([^/]+)\/work\/observations$/;
// ── orun-work v4 (WH1) — the planning hierarchy. `epics` aliases `specs`
// 1:1 (V4-C: the surface name changes, the wire kind does not).
const ORG_WORK_EPICS_RE = /^\/v1\/organizations\/([^/]+)\/work\/epics$/;
const ORG_WORK_EPIC_DOC_RE = /^\/v1\/organizations\/([^/]+)\/work\/(?:epics|designs)\/([^/]+)\/doc$/;
const ORG_WORK_EPIC_DOC_HISTORY_RE = /^\/v1\/organizations\/([^/]+)\/work\/(?:epics|designs)\/([^/]+)\/doc\/history$/;
const ORG_WORK_MILESTONES_RE = /^\/v1\/organizations\/([^/]+)\/work\/(?:epics|specs)\/([^/]+)\/milestones$/;
const ORG_WORK_REVIEW_RE = /^\/v1\/organizations\/([^/]+)\/work\/(?:epics|specs|designs)\/([^/]+)\/(review|verdict)$/;
const ORG_WORK_APPROVE_RE = /^\/v1\/organizations\/([^/]+)\/work\/(?:epics|specs)\/([^/]+)\/(approve|revoke-approval)$/;
const ORG_WORK_INITIATIVE_DESIGNS_RE = /^\/v1\/organizations\/([^/]+)\/work\/initiatives\/([^/]+)\/designs$/;
const ORG_WORK_DESIGN_RE = /^\/v1\/organizations\/([^/]+)\/work\/designs\/([^/]+)$/;
const ORG_WORK_DESIGN_DECISION_RE = /^\/v1\/organizations\/([^/]+)\/work\/designs\/([^/]+)\/(adopt|supersede)$/;
const ORG_WORK_ROLLUPS_RE = /^\/v1\/organizations\/([^/]+)\/work\/rollups$/;
const ORG_WORK_EPIC_BRIEF_RE = /^\/v1\/organizations\/([^/]+)\/work\/(?:epics|specs)\/([^/]+)\/brief$/;
const ORG_WORK_REGENERATE_RE = /^\/v1\/organizations\/([^/]+)\/work\/(?:epics|specs)\/([^/]+)\/milestones\/([^/]+)\/regenerate$/;

// OV1 — hosted RefStore (design-v2 §2). Ref names carry slashes
// (catalogs/current, executions/by-id/<id>), so the name is a greedy tail.
const REFS_RE = new RegExp(`^${STATE_BASE}/refs$`);
const REF_RE = new RegExp(`^${STATE_BASE}/refs/(.+)$`);

// OV4 — scm.* trigger activity feed.
const TRIGGERS_RE = new RegExp(`^${STATE_BASE}/triggers$`);

export async function route(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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

  // /v1/organizations/{orgId}/cli/links — POST creates a link (policy
  // org.cli.link); GET lists the org-wide allow-list (every active repo link).
  let m = pathname.match(ORG_CLI_LINKS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method === "POST") {
      return handleCreateWorkspaceLink(request, env, requestId, actor, orgId);
    }
    if (request.method === "GET") {
      return handleListOrgWorkspaceLinks(request, env, requestId, actor, orgId);
    }
    return methodNotAllowed(requestId);
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

  // GET /v1/organizations/{orgId}/catalog/entities — org-global catalog browser
  // (OV6). Org-scoped (no project), so it is dispatched here at the top level —
  // NOT under the `/state/`-gated run/object plane below.
  m = pathname.match(ORG_CATALOG_ENTITIES_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListOrgCatalogEntities(request, env, requestId, actor, orgId);
  }

  // GET /v1/organizations/{orgId}/repo-facets — repo self-descriptions for the
  // org (WO5). Org-scoped read-model, dispatched here at the top level (outside
  // the `/state/` contract-version gate), mirroring …/catalog/entities.
  m = pathname.match(ORG_REPO_FACET_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleGetOrgRepoFacet(request, env, requestId, actor, orgId, projectId);
  }
  m = pathname.match(ORG_REPO_FACETS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListOrgRepoFacets(request, env, requestId, actor, orgId);
  }
  m = pathname.match(ORG_CATALOG_DOC_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleGetOrgCatalogDoc(request, env, requestId, actor, orgId);
  }
  // GET /v1/organizations/{orgId}/catalog/docs — the org doc index (CD3).
  m = pathname.match(ORG_CATALOG_DOCS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListOrgCatalogDocs(request, env, requestId, actor, orgId);
  }

  // GET /v1/organizations/{orgId}/state/usage — org state-plane storage footprint
  // (OV9). Org-scoped (no project); dispatched here at the top level BEFORE the
  // `/state/`-gated project plane below (this path has no project segment).
  m = pathname.match(ORG_STATE_USAGE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleGetOrgStateStorage(request, env, requestId, actor, orgId);
  }

  // GET /v1/organizations/{orgId}/state/runs — org-global runs feed (Activities).
  // Org-scoped (no project segment); dispatched here at the top level BEFORE the
  // `/state/`-gated project plane below, since this path also contains `/state/`.
  m = pathname.match(ORG_RUNS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListOrgRuns(request, env, requestId, actor, orgId);
  }

  // ── orun-work v2 (WP1) — the work lens. ──
  m = pathname.match(ORG_WORK_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleWorkSummary(request, env, requestId, actor, orgId);
  }

  // Match the stream route before the plain events route (same prefix).
  m = pathname.match(ORG_WORK_EVENTS_STREAM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleStreamWorkEvents(request, env, requestId, actor, orgId);
  }

  m = pathname.match(ORG_WORK_EVENTS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListWorkEvents(request, env, requestId, actor, orgId);
  }

  m = pathname.match(ORG_WORK_SPECS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleCreateWorkSpec(request, env, requestId, actor, orgId);
  }

  m = pathname.match(ORG_WORK_INITIATIVES_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleCreateWorkInitiative(request, env, requestId, actor, orgId);
  }

  // ── orun-work v4 (WH1) — the planning hierarchy. ──
  m = pathname.match(ORG_WORK_EPICS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleCreateWorkSpec(request, env, requestId, actor, orgId);
  }

  // Match /doc/history before /doc (same prefix) — the epics/designs alias.
  m = pathname.match(ORG_WORK_EPIC_DOC_HISTORY_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleWorkDocHistory(request, env, requestId, actor, orgId, decodeURIComponent(m[2]!));
  }

  m = pathname.match(ORG_WORK_EPIC_DOC_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    const docKey = decodeURIComponent(m[2]!);
    if (request.method === "PUT") return handlePutWorkDoc(request, env, requestId, actor, orgId, docKey);
    if (request.method === "GET") return handleGetWorkDoc(request, env, requestId, actor, orgId, docKey);
    return methodNotAllowed(requestId);
  }

  // Match /regenerate before the plain milestones route (same prefix).
  m = pathname.match(ORG_WORK_REGENERATE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleWorkRegenerate(
      request, env, requestId, actor, orgId,
      decodeURIComponent(m[2]!), decodeURIComponent(m[3]!),
    );
  }

  m = pathname.match(ORG_WORK_MILESTONES_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed(requestId);
    return handleWorkMilestones(request, env, requestId, actor, orgId, decodeURIComponent(m[2]!));
  }

  m = pathname.match(ORG_WORK_REVIEW_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleWorkReview(
      request, env, requestId, actor, orgId,
      decodeURIComponent(m[2]!),
      m[3] === "review" ? "review" : "verdict",
    );
  }

  m = pathname.match(ORG_WORK_APPROVE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleWorkApprove(
      request, env, requestId, actor, orgId,
      decodeURIComponent(m[2]!),
      m[3] === "approve" ? "approve" : "revoke",
    );
  }

  m = pathname.match(ORG_WORK_INITIATIVE_DESIGNS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed(requestId);
    return handleWorkDesigns(request, env, requestId, actor, orgId, decodeURIComponent(m[2]!));
  }

  m = pathname.match(ORG_WORK_DESIGN_DECISION_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleWorkDesignDecision(
      request, env, requestId, actor, orgId,
      decodeURIComponent(m[2]!),
      m[3] === "adopt" ? "adopt" : "supersede",
    );
  }

  m = pathname.match(ORG_WORK_DESIGN_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleGetWorkDesign(request, env, requestId, actor, orgId, decodeURIComponent(m[2]!));
  }

  m = pathname.match(ORG_WORK_ROLLUPS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleWorkRollups(request, env, requestId, actor, orgId);
  }

  m = pathname.match(ORG_WORK_EPIC_BRIEF_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleWorkEpicBrief(request, env, requestId, actor, orgId, decodeURIComponent(m[2]!));
  }

  m = pathname.match(ORG_WORK_TIMELINE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleWorkTimeline(request, env, requestId, actor, orgId, decodeURIComponent(m[2]!));
  }

  m = pathname.match(ORG_WORK_REACTION_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleWorkReaction(request, env, requestId, actor, orgId, decodeURIComponent(m[2]!), m[3] ? "remove" : "add");
  }

  m = pathname.match(ORG_WORK_ITEM_EDIT_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleEditWorkItem(request, env, requestId, actor, orgId, decodeURIComponent(m[2]!));
  }

  // Match /doc/history before /doc (same prefix).
  m = pathname.match(ORG_WORK_SPEC_DOC_HISTORY_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleWorkDocHistory(request, env, requestId, actor, orgId, decodeURIComponent(m[2]!));
  }

  m = pathname.match(ORG_WORK_SPEC_DOC_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    const specKey = decodeURIComponent(m[2]!);
    if (request.method === "PUT") return handlePutWorkDoc(request, env, requestId, actor, orgId, specKey);
    if (request.method === "GET") return handleGetWorkDoc(request, env, requestId, actor, orgId, specKey);
    return methodNotAllowed(requestId);
  }

  m = pathname.match(ORG_WORK_TASKS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleCreateWorkTask(request, env, requestId, actor, orgId);
  }

  m = pathname.match(ORG_WORK_TASK_ACTION_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleWorkTaskAction(
      request, env, requestId, actor, orgId,
      decodeURIComponent(m[2]!),
      m[3]! as "comment" | "assign" | "pin" | "cancel" | "contract" | "label" | "priority" | "estimate" | "relate" | "order" | "cycle" | "milestone",
    );
  }

  m = pathname.match(ORG_WORK_VIEWS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method === "POST") return handleSaveWorkView(request, env, requestId, actor, orgId);
    if (request.method === "GET") return handleListWorkViews(request, env, requestId, actor, orgId);
    return methodNotAllowed(requestId);
  }

  m = pathname.match(ORG_WORK_TRIAGE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleWorkTriage(request, env, requestId, actor, orgId);
  }

  // Match /burnup before the plain cycles route (same prefix).
  m = pathname.match(ORG_WORK_CYCLE_BURNUP_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleWorkBurnup(request, env, requestId, actor, orgId, decodeURIComponent(m[2]!));
  }

  m = pathname.match(ORG_WORK_CYCLES_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method === "POST") return handleCreateWorkCycle(request, env, requestId, actor, orgId);
    if (request.method === "GET") return handleListWorkCycles(request, env, requestId, actor, orgId);
    return methodNotAllowed(requestId);
  }

  m = pathname.match(ORG_WORK_OBSERVATIONS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleIngestWorkObservation(request, env, requestId, actor, orgId);
  }

  m = pathname.match(ORG_WORK_IMPORT_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleWorkImport(request, env, requestId, actor, orgId);
  }

  // ── OP2 — Run coordination plane (§2). ──
  // Every run route enforces Orun-Contract-Version before any work.
  if (pathname.includes("/state/")) {
    const versionError = enforceContractVersion(request, requestId);
    if (versionError) return versionError;
    const runResponse = await routeRun(request, env, requestId, actor, pathname, ctx);
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
  ctx?: ExecutionContext,
): Promise<Response | null> {
  // ── OP3 — Object & log plane (§3) + catalog heads (§3.1). ──
  const objectOrCatalog = await routeObjectAndCatalog(request, env, requestId, actor, pathname, ctx);
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

  // ── Native v2 coordination wire (coordination-api.md §2/§3) ──
  // Matched before the OP2 routes and the greedy single-run GET (RUN_RE). The
  // colon-verbs/log/frontier route to the per-run RunCoordinator DO.
  m = pathname.match(RUN_JOB_CLAIM_NATIVE_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleNativeClaim(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!, m[4]!, undefined, ctx);
  }
  m = pathname.match(RUN_JOB_HEARTBEAT_NATIVE_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleNativeHeartbeat(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!, m[4]!);
  }
  m = pathname.match(RUN_JOB_COMPLETE_NATIVE_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleNativeComplete(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!, m[4]!, undefined, ctx);
  }
  m = pathname.match(RUN_CANCEL_NATIVE_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleNativeCancel(env, requestId, actor, scope.orgId, scope.projectId, m[3]!, undefined, ctx);
  }
  m = pathname.match(RUN_LOG_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleNativeLog(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!);
  }
  m = pathname.match(RUN_FRONTIER_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleNativeFrontier(env, requestId, actor, scope.orgId, scope.projectId, m[3]!);
  }

  // POST …/runs/{runId}/secrets/resolve (SM3) — the lease-bound secret resolve.
  // Matched before the greedy single-run GET; the slash form is disjoint from
  // the colon-verbs above.
  m = pathname.match(RUN_SECRETS_RESOLVE_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope || !isRunUlid(m[3]!)) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleResolveRunSecrets(request, env, requestId, actor, scope.orgId, scope.projectId, m[3]!);
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
  ctx?: ExecutionContext,
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
      return handleAdvanceCatalogHead(request, env, requestId, actor, scope.orgId, scope.projectId, undefined, ctx);
    }
    if (request.method === "GET") {
      return handleGetCatalogHead(request, env, requestId, actor, scope.orgId, scope.projectId);
    }
    return methodNotAllowed(requestId);
  }

  // POST …/state/catalog/reproject — force re-projection of the current head.
  m = pathname.match(CATALOG_REPROJECT_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleReprojectCatalogHead(request, env, requestId, actor, scope.orgId, scope.projectId);
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

  // GET …/state/gc/report — object GC reachability report (OV9, report-only).
  m = pathname.match(GC_REPORT_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleGetStateGcReport(request, env, requestId, actor, scope.orgId, scope.projectId);
  }

  // POST …/state/gc/collect — object GC reclamation (OV9, safe-by-default).
  m = pathname.match(GC_COLLECT_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return handleCollectStateGc(request, env, requestId, actor, scope.orgId, scope.projectId);
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

  // GET …/state/triggers?repo=&cursor= — the scm.* activity feed (OV4).
  m = pathname.match(TRIGGERS_RE);
  if (m) {
    const scope = parseScope(m[1]!, m[2]!);
    if (!scope) return notFound(requestId, pathname);
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return handleListTriggers(request, env, requestId, actor, scope.orgId, scope.projectId);
  }

  return null;
}

function parseScope(orgPublic: string, projectPublic: string): { orgId: ReturnType<typeof asUuid>; projectId: ReturnType<typeof asUuid> } | null {
  const orgId = parseOrgPublicId(orgPublic);
  const projectId = parseProjectPublicId(projectPublic);
  if (!orgId || !projectId) return null;
  return { orgId, projectId };
}
