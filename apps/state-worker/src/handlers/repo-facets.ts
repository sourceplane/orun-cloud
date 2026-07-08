// Repo-facet reads (saas-workspace-overview WO5) — the org-global read model's
// repo self-description surface. One row per (org, project), projected from the
// declared Repo entity on catalog.head.advanced (WO4). Org-scoped read, gated on
// catalog.read like the catalog browser; kept outside `/state/` so it skips the
// contract-version gate (mirrors …/catalog/entities).

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  ListRepoFacetsResponse,
  GetRepoFacetResponse,
  RepoFacet as PublicRepoFacet,
  CatalogDoc as PublicCatalogDoc,
  ListCatalogDocsResponse,
} from "@saas/contracts/state";
import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import {
  createStateRepository,
  type RepoFacet,
  type CatalogDoc,
  type ListCatalogDocsQuery,
} from "@saas/db/state";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse, validationError } from "../http.js";
import { authorizeOrg } from "../authz.js";
import { requireBucket, objectKey, isValidDigest } from "../object-store.js";
import { deframeObject } from "../object-model.js";
import { orgPublicId, projectPublicId, parseProjectPublicId } from "../ids.js";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../constants.js";

export interface RepoFacetHandlerDeps {
  executor?: SqlExecutor;
}

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

function toPublicRepoFacet(f: RepoFacet): PublicRepoFacet {
  return {
    orgId: orgPublicId(f.orgId),
    projectId: projectPublicId(f.sourceProjectId),
    displayName: f.displayName,
    description: f.description,
    owner: f.owner,
    defaultBranch: f.defaultBranch,
    links: f.links,
    tags: f.tags,
    docRef: f.docRef,
    entityRef: f.entityRef,
    headDigest: f.headDigest,
    sourceCommit: f.sourceCommit,
    syncedAt: f.syncedAt.toISOString(),
  };
}

export async function handleListOrgRepoFacets(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: RepoFacetHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, STATE_POLICY_ACTIONS.CATALOG_READ);
  if (!authz.ok) return authz.response;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.listRepoFacets(orgId);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const payload: ListRepoFacetsResponse = { repoFacets: result.value.map(toPublicRepoFacet) };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

export async function handleGetOrgRepoFacet(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: RepoFacetHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, STATE_POLICY_ACTIONS.CATALOG_READ);
  if (!authz.ok) return authz.response;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const result = await repo.getRepoFacet(orgId, projectId);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const payload: GetRepoFacetResponse = {
      repoFacet: result.value ? toPublicRepoFacet(result.value) : null,
    };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

function toPublicCatalogDoc(d: CatalogDoc): PublicCatalogDoc {
  return {
    orgId: orgPublicId(d.orgId),
    projectId: projectPublicId(d.sourceProjectId),
    sourceEnvironment: d.sourceEnvironment,
    entityRef: d.entityRef,
    entityKind: d.entityKind,
    entityName: d.entityName,
    docKey: d.docKey,
    title: d.title,
    role: d.role,
    path: d.path,
    commitSha: d.commitSha,
    digest: d.digest,
    sizeBytes: d.sizeBytes,
    position: d.position,
    headDigest: d.headDigest,
    syncedAt: d.syncedAt.toISOString(),
  };
}

// ── GET /v1/organizations/{orgId}/catalog/docs — the org doc index ─────
//
// The Docs hub / entity Docs tab browse (saas-catalog-docs CD3): one row per
// attached doc across every entity kind, filterable by project/environment/
// kind/entityRef/role/q, keyset-paged. Gated on catalog.read like the entity
// browser; org-scoped, outside the `/state/` contract-version gate. The BODY
// is read separately by digest via …/catalog/doc?digest= (immutable, cacheable).
export async function handleListOrgCatalogDocs(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: RepoFacetHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, STATE_POLICY_ACTIONS.CATALOG_READ);
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const query: ListCatalogDocsQuery = {};
  const projectParam = url.searchParams.get("project");
  if (projectParam) {
    const projectUuid = parseProjectPublicId(projectParam);
    if (!projectUuid) return validationError(requestId, { project: ["Malformed project id"] });
    query.sourceProjectId = projectUuid;
  }
  const envParam = url.searchParams.get("environment");
  if (envParam && envParam.length > 0) query.sourceEnvironment = envParam;
  const kind = url.searchParams.get("kind");
  if (kind) query.entityKind = kind;
  const entityRef = url.searchParams.get("entityRef");
  if (entityRef) query.entityRef = entityRef;
  const role = url.searchParams.get("role");
  if (role) query.role = role;
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
    const result = await repo.listCatalogDocs(orgId, { limit, cursor }, query);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const nextCursor = result.value.nextCursor
      ? { createdAt: result.value.nextCursor.createdAt, id: result.value.nextCursor.id }
      : null;
    const payload: ListCatalogDocsResponse = {
      docs: result.value.items.map(toPublicCatalogDoc),
      nextCursor,
    };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET /v1/organizations/{orgId}/catalog/doc?digest=… ───────
//
// Read a git-authored overview doc by content digest, for the Workspace Overview
// narrative (WO5). This is the console-facing doc read: unlike the CLI object GET
// (project-scoped OBJECT_READ, returns the framed object), it is
//
//   1. gated on org catalog.read — the same authorization the identity/facets
//      already use, so a console user who can see the workspace can read its
//      overview (the raw object GET required project OBJECT_READ and matched the
//      digest's colon literally, so an SDK-encoded `sha256%3A…` 404'd);
//   2. authorized + scoped by the read model — the digest must be a doc_ref in
//      this org's catalog (repo_facet / org_catalog_entities), which also locates
//      the object's project; and
//   3. deframed — returns the raw markdown body (the object store frames blobs as
//      `blob <len>\0<body>`; the console renders markdown, not the frame).
//
// The digest travels as a query param so its `sha256:` colon is decoded normally.
export async function handleGetOrgCatalogDoc(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: RepoFacetHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, STATE_POLICY_ACTIONS.CATALOG_READ);
  if (!authz.ok) return authz.response;

  const digest = new URL(request.url).searchParams.get("digest") ?? "";
  if (!isValidDigest(digest)) return errorResponse("not_found", "Not found", 404, requestId);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    // findCatalogDocProject resolves the digest against this org's catalog read
    // model — encoding-agnostic, so it matches whether doc_ref is stored as a
    // proper JSONB object or a double-encoded string scalar (packages/db).
    const scope = await repo.findCatalogDocProject(orgId, digest);
    if (!scope.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    if (!scope.value) return errorResponse("not_found", "Not found", 404, requestId);
    const projectId = scope.value;

    const bucketResult = requireBucket(env);
    if (!bucketResult.ok) {
      return errorResponse(bucketResult.code, bucketResult.message, bucketResult.status, requestId);
    }
    const r2 = await bucketResult.bucket.get(objectKey(orgPublicId(orgId), projectPublicId(projectId), digest));
    if (!r2) return errorResponse("not_found", "Not found", 404, requestId);
    const framed = new Uint8Array(await r2.arrayBuffer());
    const obj = deframeObject(framed);
    if (!obj) return errorResponse("not_found", "Not found", 404, requestId);

    // The deframed body is git-authored markdown; return it as UTF-8 text (the
    // console renders it through its sanitizing markdown pipeline, WO5).
    return new Response(new TextDecoder().decode(obj.body), {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "x-request-id": requestId,
      },
    });
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}
