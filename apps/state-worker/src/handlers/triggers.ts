// scm.* triggers read surface (OV4 inbound bridge — design-v2 §5).
//
// The inbound activity feed: pushes/PRs the scm.* drain (scm-bridge.ts) projected
// into state.triggers, read project-scoped and newest-first. The console/TUI
// render "what happened" here BEFORE (and independently of) any object-graph
// materialization. Read gates on state.run.read (run-adjacent activity).

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ListTriggersResponse, StateTrigger as PublicStateTrigger } from "@saas/contracts/state";
import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import { createStateRepository, type StateTrigger } from "@saas/db/state";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, listResponse, validationError } from "../http.js";
import { authorizeRun } from "../authz.js";
import { orgPublicId, projectPublicId } from "../ids.js";
import { DEFAULT_PAGE_LIMIT } from "../constants.js";

export interface TriggersHandlerDeps {
  executor?: SqlExecutor;
}

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

function toPublic(t: StateTrigger): PublicStateTrigger {
  return {
    orgId: orgPublicId(t.orgId),
    projectId: t.projectId ? projectPublicId(t.projectId) : null,
    provider: t.provider,
    providerRepoId: t.providerRepoId,
    repoFullName: t.repoFullName,
    kind: t.kind,
    action: t.action,
    ref: t.ref,
    commitSha: t.commitSha,
    baseSha: t.baseSha,
    prNumber: t.prNumber,
    actorLogin: t.actorLogin,
    status: t.status,
    occurredAt: t.occurredAt.toISOString(),
  };
}

// GET …/projects/{project}/state/triggers?repo=&cursor= — project-scoped feed.
export async function handleListTriggers(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: TriggersHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_READ);
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const repo = url.searchParams.get("repo");
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
    const repoStore = createStateRepository(executor);
    const result = await repoStore.listTriggers(
      orgId,
      { limit: DEFAULT_PAGE_LIMIT, cursor },
      { projectId, ...(repo ? { providerRepoId: repo } : {}) },
    );
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const nextCursor = result.value.nextCursor
      ? { createdAt: result.value.nextCursor.createdAt, id: result.value.nextCursor.id }
      : null;
    const payload: ListTriggersResponse = {
      triggers: result.value.items.map(toPublic),
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
