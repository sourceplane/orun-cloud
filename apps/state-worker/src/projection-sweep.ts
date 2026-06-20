// Coordination projection sweep (BM3d). The DO autonomously sweeps lapsed leases
// on its alarm (re-queue / time-out), but those transitions only reach the
// Postgres read model when a client next hits a verb (BM3c). This cron phase
// closes that gap: it folds a bounded batch of non-terminal runs and projects
// them, so an abandoned run's status (e.g. timed_out) surfaces in `orun status`
// without client traffic. Coalesced into the single state-worker cron slot
// (risk R9 — a phase of the scheduled handler, never a new cron).

import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { projectCoordinatorRun, useDoCoordination } from "./coordination-route.js";
import type { Env } from "./env.js";

/** Bounded so the phase stays within the cron budget; oldest-touched first. */
const PROJECTION_BATCH = 200;

export interface ProjectionSweepSummary {
  scanned: number;
  projected: number;
}

/**
 * Project a bounded batch of non-terminal runs from their DO shards. Runs with no
 * new events no-op via the seq guard; OP2-era runs (no shard) no-op too (an
 * uninitialized shard folds to lastSeq 0). Returns null when the DO backend is
 * not active (dormant) or Postgres is unbound. Best-effort per run.
 */
export async function runProjectionSweep(
  env: Env,
  deps?: { executor?: SqlExecutor },
): Promise<ProjectionSweepSummary | null> {
  if (!useDoCoordination(env)) return null;
  if (!deps?.executor && !env.PLATFORM_DB) return null;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  let scanned = 0;
  let projected = 0;
  try {
    const rows = await executor.execute<{ org_id: string; project_id: string; run_ulid: string }>(
      `SELECT org_id, project_id, run_ulid FROM state.runs
        WHERE status IN ('pending', 'running')
        ORDER BY updated_at ASC
        LIMIT $1`,
      [PROJECTION_BATCH],
    );
    for (const r of rows.rows) {
      scanned += 1;
      try {
        await projectCoordinatorRun(
          env,
          executor,
          { orgId: r.org_id as Uuid, projectId: r.project_id as Uuid },
          r.run_ulid,
        );
        projected += 1;
      } catch (err) {
        // Best-effort per run — one shard's failure never stalls the batch — but
        // log it so a *systemic* projection failure (e.g. migration 350 not yet
        // applied on this environment) is visible in tail rather than presenting
        // as a silently frozen read model across every run.
        console.error(`[projection-sweep] run ${r.run_ulid} projection failed: ${String(err)}`);
      }
    }
  } finally {
    if (!deps?.executor && "dispose" in executor) {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
  return { scanned, projected };
}
