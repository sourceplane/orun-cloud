// Catalog heads (OP3 — state-api-contract §3.1, design §4.1).
//
// A catalog head is the only mutable pointer in the CAS plane: (project,
// environment?) → a `catalog-snapshot` digest. Advancing inserts a new history
// row (history is retained), checks the digest exists in the object plane, and
// emits `catalog.head.advanced`. Reads return the current head per scope and the
// advance history. The `catalog/entities` read-model projection is DEFERRED to
// OP7 — this handler stubs it `501 {milestone:"OP7"}` and does not build the
// projection.
//
// Policy: head read gates on catalog.read, head advance on catalog.publish (§6).

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  PutCatalogHeadResponse,
  GetCatalogHeadResponse,
  ListCatalogHeadHistoryResponse,
  ListOrgCatalogEntitiesResponse,
  CatalogHead as PublicCatalogHead,
  OrgCatalogEntity as PublicOrgCatalogEntity,
} from "@saas/contracts/state";
import { STATE_EVENT_TYPES, STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import {
  createStateRepository,
  type CatalogHead,
  type OrgCatalogEntity,
  type ListOrgCatalogEntitiesQuery,
} from "@saas/db/state";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse, listResponse, validationError } from "../http.js";
import { authorizeRun, authorizeOrg } from "../authz.js";
import { projectCatalogSnapshot } from "../catalog-projection.js";
import { ensureEnvironmentRegistered } from "../env-registration.js";
import { generateUuid, orgPublicId, projectPublicId, parseProjectPublicId } from "../ids.js";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../constants.js";
import { isValidDigest } from "../object-store.js";

export interface CatalogHandlerDeps {
  executor?: SqlExecutor;
}

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

function actorRef(h: CatalogHead): PublicCatalogHead["advancedBy"] {
  const kind = h.advancedBy.kind;
  const safeKind: PublicCatalogHead["advancedBy"]["kind"] =
    kind === "user" || kind === "service_principal" || kind === "workflow" || kind === "system"
      ? kind
      : "system";
  return { id: h.advancedBy.id ?? "", kind: safeKind };
}

function toPublicHead(h: CatalogHead): PublicCatalogHead {
  return {
    orgId: orgPublicId(h.orgId),
    projectId: projectPublicId(h.projectId),
    environment: h.environment,
    digest: h.digest,
    commit: h.commit,
    advancedBy: actorRef(h),
    advancedAt: h.advancedAt.toISOString(),
  };
}

function actorKindOf(subjectType: string): "user" | "service_principal" | "workflow" | "system" {
  switch (subjectType) {
    case "user":
    case "service_principal":
    case "workflow":
    case "system":
      return subjectType;
    default:
      return "system";
  }
}

// ── PUT …/state/catalog/head — advance (digest must exist) ──

export async function handleAdvanceCatalogHead(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: CatalogHandlerDeps,
  ctx?: ExecutionContext,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.CATALOG_PUBLISH);
  if (!authz.ok) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const fields: Record<string, string[]> = {};
  const digest = typeof body.digest === "string" ? body.digest : "";
  if (!digest || !isValidDigest(digest)) fields.digest = ["Required; 'sha256:<64 hex>'"];

  let environment: string | null = null;
  if (body.environment !== undefined && body.environment !== null) {
    if (typeof body.environment !== "string") fields.environment = ["Must be a string or null"];
    else environment = body.environment;
  }
  const commit = typeof body.commit === "string" ? body.commit : null;
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);

    // ── The digest must exist in the object plane (else object_missing). ──
    const obj = await repo.getObject(orgId, projectId, digest);
    if (!obj.ok) {
      return errorResponse(
        "object_missing",
        `Catalog snapshot ${digest} not found in the object plane`,
        412,
        requestId,
        { digest },
      );
    }

    // Capture the head this advance replaces (for the {previous} response).
    const previousResult = await repo.getCatalogHead(orgId, projectId, environment);
    const previous = previousResult.ok ? toPublicHead(previousResult.value) : null;

    const advanced = await repo.advanceCatalogHead({
      id: generateUuid(),
      orgId,
      projectId,
      environment,
      digest,
      commit,
      advancedBy: { id: actor.subjectId, kind: actorKindOf(actor.subjectType) },
    });
    if (!advanced.ok) {
      if (advanced.error.kind === "conflict") {
        // Composite FK to state.objects failed → digest disappeared mid-flight.
        return errorResponse(
          "object_missing",
          `Catalog snapshot ${digest} not found in the object plane`,
          412,
          requestId,
          { digest },
        );
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const head = advanced.value;

    // ── Emit catalog.head.advanced (best-effort audit; never fails advance). ──
    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: STATE_EVENT_TYPES.CATALOG_HEAD_ADVANCED,
          version: 1,
          source: "state-worker",
          occurredAt: new Date(),
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          projectId,
          subjectKind: "catalog_head",
          subjectId: head.id,
          subjectName: head.environment ?? "(project-wide)",
          requestId,
          payload: {
            version: 1,
            orgId: orgPublicId(orgId),
            projectId: projectPublicId(projectId),
            environment: head.environment,
            digest: head.digest,
            commit: head.commit,
            previousDigest: previous ? previous.digest : null,
          },
        },
        audit: {
          id: generateUuid(),
          category: "catalog",
          description: `Advanced catalog head${head.environment ? ` (${head.environment})` : ""} to ${head.digest}`,
          projectId,
        },
      });
    } catch {
      // Best-effort audit.
    }

    // ── Project the snapshot into the org-global read model (OV6) — OFF the
    // response path. Walking the snapshot (R2 fetches + upserts) can exceed the
    // client timeout for a real catalog, so it must NOT block the advance: the
    // head is the source of truth and the read model is always rebuildable from
    // it. We hand the work to ctx.waitUntil so the response returns immediately
    // and the projection runs in the background with its OWN executor (the
    // request's executor is disposed in the finally below). Best-effort +
    // idempotent (replace-the-scope), so a re-advance simply re-projects.
    const scope = {
      orgId,
      projectId,
      orgPublic: orgPublicId(orgId),
      projectPublic: projectPublicId(projectId),
      environment: head.environment,
      digest: head.digest,
      commit: head.commit,
    };
    if (ctx) {
      ctx.waitUntil(
        projectCatalogSnapshot(env, scope).catch((e) =>
          // The advance already succeeded; the projection is best-effort, so we
          // never fail the response — but DO log so an empty org-global console
          // is diagnosable (projectCatalogSnapshot logs the specifics).
          console.error(
            JSON.stringify({
              level: "error",
              scope: "state.catalog.projection",
              reason: "waituntil_failed",
              requestId,
              digest: scope.digest,
              error: String(e),
            }),
          ),
        ),
      );
    } else {
      // No execution context (unit tests / non-Worker callers): project inline.
      // Dormant without R2, so this is a fast no-op there.
      try {
        await projectCatalogSnapshot(env, scope, { executor });
      } catch {
        // Best-effort projection.
      }
    }

    // ── Catalog-push liveness (OV9): bump the environment's last_active_at so a
    // project that pushes catalogs per-env (without runs) doesn't have its envs
    // wrongly archived by the stale-archival sweep. Off the response path
    // (waitUntil) — a head advance must never wait on projects-worker.
    if (head.environment && env.PROJECTS_WORKER) {
      const touch = ensureEnvironmentRegistered(
        env.PROJECTS_WORKER,
        orgId,
        projectId,
        head.environment,
        requestId,
      );
      if (ctx) ctx.waitUntil(touch.then(() => undefined).catch(() => undefined));
      else await touch.catch(() => undefined);
    }

    const payload: PutCatalogHeadResponse = { head: toPublicHead(head), previous };
    return successResponse(payload, requestId, 200);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET …/state/catalog/head?environment= ───────────────────

export async function handleGetCatalogHead(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: CatalogHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.CATALOG_READ);
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const envParam = url.searchParams.get("environment");
  const environment = envParam && envParam.length > 0 ? envParam : null;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const head = await repo.getCatalogHead(orgId, projectId, environment);
    const payload: GetCatalogHeadResponse = { head: head.ok ? toPublicHead(head.value) : null };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET …/state/catalog/heads/history?cursor= ───────────────

export async function handleCatalogHeadHistory(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: CatalogHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.CATALOG_READ);
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const cursorParam = url.searchParams.get("cursor");
  let cursor: { createdAt: string; id: string } | null = null;
  if (cursorParam) {
    const idx = cursorParam.indexOf("|");
    if (idx <= 0) return validationError(requestId, { cursor: ["Malformed cursor"] });
    cursor = { createdAt: cursorParam.slice(0, idx), id: cursorParam.slice(idx + 1) };
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.listCatalogHeadHistory(orgId, projectId, {
      limit: DEFAULT_PAGE_LIMIT,
      cursor,
    });
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const nextCursor = result.value.nextCursor
      ? { createdAt: result.value.nextCursor.createdAt, id: result.value.nextCursor.id }
      : null;
    const payload: ListCatalogHeadHistoryResponse = {
      heads: result.value.items.map(toPublicHead),
      nextCursor,
    };
    const cursorStr = nextCursor ? `${nextCursor.createdAt}|${nextCursor.id}` : null;
    return listResponse(payload, requestId, cursorStr);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET …/state/catalog/entities — DEFERRED to OP7 ──────────
// The entity read-model projection (list/search/filter over catalog-snapshot
// content) is OP7 work. The route exists and authorizes like a catalog read,
// then returns a clear 501 so clients get an actionable signal rather than a 404.

export async function handleListCatalogEntities(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.CATALOG_READ);
  if (!authz.ok) return authz.response;
  return errorResponse(
    "not_implemented",
    "The catalog entity read-model lands in OP7. The route exists; the projection is not yet available.",
    501,
    requestId,
    { milestone: "OP7" },
  );
}

// ── GET /v1/organizations/{orgId}/catalog/entities — org-global browser (OV6) ─
// The default catalog view: one org-wide component graph merged across projects,
// each row carrying provenance (project, env, commit). Optional filters: project
// + environment narrow to a repo/env sublist; kind/owner are facets; q matches
// name or ref. Org-scoped read (catalog.read on the organization).

function toPublicOrgEntity(e: OrgCatalogEntity): PublicOrgCatalogEntity {
  return {
    orgId: orgPublicId(e.orgId),
    entityRef: e.entityRef,
    kind: e.kind,
    name: e.name,
    owner: e.owner,
    lifecycle: e.lifecycle,
    relations: e.relations,
    description: e.description,
    system: e.system,
    language: e.language,
    tags: e.tags,
    sourceProjectId: projectPublicId(e.sourceProjectId),
    sourceEnvironment: e.sourceEnvironment,
    sourceCommit: e.sourceCommit,
    headDigest: e.headDigest,
  };
}

export async function handleListOrgCatalogEntities(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: CatalogHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, STATE_POLICY_ACTIONS.CATALOG_READ);
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);

  // Optional provenance filter: ?project=prj_… (parsed to uuid; bad id → 422).
  const query: ListOrgCatalogEntitiesQuery = {};
  const projectParam = url.searchParams.get("project");
  if (projectParam) {
    const projectUuid = parseProjectPublicId(projectParam);
    if (!projectUuid) return validationError(requestId, { project: ["Malformed project id"] });
    query.sourceProjectId = projectUuid;
  }
  // ?environment=prod narrows to that env; omitted = any (no env filter).
  const envParam = url.searchParams.get("environment");
  if (envParam && envParam.length > 0) query.sourceEnvironment = envParam;
  const kind = url.searchParams.get("kind");
  if (kind) query.kind = kind;
  const owner = url.searchParams.get("owner");
  if (owner) query.owner = owner;
  const q = url.searchParams.get("q");
  if (q) query.q = q;

  let limit = DEFAULT_PAGE_LIMIT;
  const limitParam = url.searchParams.get("limit");
  if (limitParam) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
      return validationError(requestId, { limit: [`Must be 1..${MAX_PAGE_LIMIT}`] });
    }
    limit = parsed;
  }

  const cursorParam = url.searchParams.get("cursor");
  let cursor: { createdAt: string; id: string } | null = null;
  if (cursorParam) {
    const idx = cursorParam.indexOf("|");
    if (idx <= 0) return validationError(requestId, { cursor: ["Malformed cursor"] });
    cursor = { createdAt: cursorParam.slice(0, idx), id: cursorParam.slice(idx + 1) };
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.listOrgCatalogEntities(orgId, { limit, cursor }, query);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const nextCursor = result.value.nextCursor
      ? { createdAt: result.value.nextCursor.createdAt, id: result.value.nextCursor.id }
      : null;
    const payload: ListOrgCatalogEntitiesResponse = {
      entities: result.value.items.map(toPublicOrgEntity),
      nextCursor,
    };
    const cursorStr = nextCursor ? `${nextCursor.createdAt}|${nextCursor.id}` : null;
    return listResponse(payload, requestId, cursorStr);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}
