// Projector apply (BM3 runtime shell). Writes a folded run's read-model rows into
// Postgres, guarded by the per-run high-water mark (state.runs.last_seq) so the
// projection is idempotent under replay and out-of-order delivery. The decision
// of *what* to write (status mapping, idempotency gate) is the pure planProjection
// in @saas/contracts; this is the thin SQL shell that *applies* it. The DO log is
// the authority — these rows are a delayed projection, never a source of truth.

import type { ProjectionPlan } from "@saas/contracts/coordination-projector";
import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";

export interface ProjectionScope {
  orgId: Uuid;
  projectId: Uuid;
}

/**
 * Apply a projection plan to the read model. The run row update is guarded on
 * `last_seq < plan.lastSeq` (a single conditional UPDATE), so a replayed or
 * stale fold writes nothing and a concurrent newer write always wins. Job rows
 * (seeded at create) are updated in place. Returns whether anything was written.
 */
export async function applyProjection(
  executor: SqlExecutor,
  scope: ProjectionScope,
  plan: ProjectionPlan,
): Promise<{ applied: boolean }> {
  if (!plan.apply || !plan.run) return { applied: false };

  // Seq-guarded run update. RETURNING id both proves the guard passed (0 rows ⇒
  // the read model is already at/ahead of this fold) and yields the FK for jobs.
  const runRes = await executor.execute<{ id: string }>(
    `UPDATE state.runs
        SET status = $4, last_seq = $5, updated_at = now()
      WHERE org_id = $1 AND project_id = $2 AND run_ulid = $3 AND last_seq < $5
      RETURNING id`,
    [scope.orgId, scope.projectId, plan.run.runId, plan.run.status, plan.run.lastSeq],
  );
  if (runRes.rows.length === 0) return { applied: false };
  const runRowId = runRes.rows[0]!.id;

  for (const job of plan.jobs ?? []) {
    await executor.execute(
      `UPDATE state.run_jobs
          SET status = $4, runner_id = $5, lease_expires_at = $6, attempt = $7,
              error_text = $8, updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND run_id = $3 AND job_id = $9`,
      [
        scope.orgId,
        scope.projectId,
        runRowId,
        job.status,
        job.holder,
        job.leaseExpiresAt,
        job.attempt,
        job.errorText,
        job.jobId,
      ],
    );
  }
  return { applied: true };
}
