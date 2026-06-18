// Object GC reclamation endpoint (OV9 — the deleting path, fenced).
//
// POST /v1/organizations/{orgId}/projects/{projectId}/state/gc/collect — reclaim
// a project's unreachable objects. SAFE BY DEFAULT, layered:
//   1. Master kill-switch: env.STATE_GC_COLLECT_ENABLED must be "true", else the
//      call can only ever dry-run (never deletes), whatever the request says.
//   2. Request dryRun defaults true; deletion needs an explicit dryRun:false.
//   3. The reachability walk must be complete — a `capped` walk refuses deletion.
//   4. Only objects older than graceDays (default 7) are eligible.
// Project-scoped write, gated on state.object.write. Deletions are audited.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { CollectStateGcResponse } from "@saas/contracts/state";
import { STATE_POLICY_ACTIONS, STATE_EVENT_TYPES } from "@saas/contracts/state";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { createEventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse, validationError } from "../http.js";
import { authorizeRun } from "../authz.js";
import { collectStorageGc, type StorageGcCollectDeps } from "../gc-reachability.js";
import { generateUuid, orgPublicId, projectPublicId } from "../ids.js";

export interface GcCollectHandlerDeps {
  executor?: SqlExecutor;
  fetcher?: StorageGcCollectDeps["fetcher"];
  deleter?: StorageGcCollectDeps["deleter"];
}

const DAY_MS = 86_400_000;
const DEFAULT_GRACE_DAYS = 7;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

export async function handleCollectStateGc(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: GcCollectHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.OBJECT_WRITE);
  if (!authz.ok) return authz.response;

  let body: Record<string, unknown> = {};
  try {
    const raw = await request.text();
    if (raw.trim().length > 0) body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  let graceDays = DEFAULT_GRACE_DAYS;
  if (body.graceDays !== undefined) {
    if (typeof body.graceDays !== "number" || !Number.isInteger(body.graceDays) || body.graceDays < 0 || body.graceDays > 3650) {
      return validationError(requestId, { graceDays: ["Must be an integer 0..3650"] });
    }
    graceDays = body.graceDays;
  }
  let limit = DEFAULT_LIMIT;
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > MAX_LIMIT) {
      return validationError(requestId, { limit: [`Must be an integer 1..${MAX_LIMIT}`] });
    }
    limit = body.limit;
  }

  // Two locks must BOTH open to delete: the per-env master switch and an explicit
  // dryRun:false. Default → dry-run. Disabled env → dry-run no matter what.
  const enabled = env.STATE_GC_COLLECT_ENABLED === "true";
  const dryRun = !(enabled && body.dryRun === false);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const scope = {
      orgId,
      projectId,
      orgPublic: orgPublicId(orgId),
      projectPublic: projectPublicId(projectId),
    };
    const result = await collectStorageGc(env, scope, { dryRun, graceMs: graceDays * DAY_MS, limit }, {
      executor,
      ...(deps?.fetcher ? { fetcher: deps.fetcher } : {}),
      ...(deps?.deleter ? { deleter: deps.deleter } : {}),
    });
    if (!result) {
      return errorResponse("internal_error", "Object storage is not available in this environment.", 503, requestId);
    }

    // Audit any real reclamation (destructive op — leave a queryable trail).
    if (result.deletedObjects > 0) {
      console.warn(
        `[gc-collect] org=${orgPublicId(orgId)} project=${projectPublicId(projectId)} ` +
          `deleted ${result.deletedObjects} objects (${result.deletedBytes} bytes)`,
      );
      try {
        const events = createEventsRepository(executor);
        await events.appendEventWithAudit({
          event: {
            id: generateUuid(),
            type: STATE_EVENT_TYPES.GC_COLLECTED,
            version: 1,
            source: "state-worker",
            occurredAt: new Date(),
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            projectId,
            subjectKind: "object_gc",
            subjectId: projectPublicId(projectId),
            subjectName: "object-gc",
            requestId,
            payload: {
              version: 1,
              orgId: orgPublicId(orgId),
              projectId: projectPublicId(projectId),
              deletedObjects: result.deletedObjects,
              deletedBytes: result.deletedBytes,
              graceDays,
            },
          },
          audit: {
            id: generateUuid(),
            category: "objects",
            description: `Reclaimed ${result.deletedObjects} unreachable objects (${result.deletedBytes} bytes)`,
            projectId,
          },
        });
      } catch {
        // Best-effort audit; never fail the collect on the trail.
      }
    }

    const payload: CollectStateGcResponse = { result: { ...result, graceDays } };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}
