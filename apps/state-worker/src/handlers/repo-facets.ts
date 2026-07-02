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
} from "@saas/contracts/state";
import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import { createStateRepository, type RepoFacet } from "@saas/db/state";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse } from "../http.js";
import { authorizeOrg } from "../authz.js";
import { orgPublicId, projectPublicId } from "../ids.js";

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
