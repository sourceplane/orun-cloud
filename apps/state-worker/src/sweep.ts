// Lease sweep (OP2 — design §4.2). The single cron-driven maintenance pass for
// the run-coordination plane. It is what makes runs survive killed laptops: a
// claimed/running job whose lease lapsed is re-queued (attempt+1, bounded) so a
// second runner can finish it, or — past MAX_JOB_ATTEMPTS — marked `timed_out`.
// After re-queue/timeout it recomputes each affected run's derived terminal
// status and emits the run/job lifecycle events.
//
// CRON-SLOT BUDGET (risk R9): this is driven by ONE scheduled handler / ONE
// cron trigger (see index.ts + wrangler.template.jsonc). Do NOT add more cron
// triggers — coalesce future state maintenance (e.g. OP9 retention/GC) into
// this same handler, fanning out by phase, rather than registering new slots.

import type { Env } from "./env.js";
import type { ActorContext } from "./router.js";
import type { Run, SweptJob } from "@saas/db/state";
import { createStateRepository } from "@saas/db/state";
import { createEventsRepository } from "@saas/db/events";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { STATE_EVENT_TYPES } from "@saas/contracts/state";
import { asUuid } from "@saas/db/ids";
import { generateRequestId, generateUuid, orgPublicId, projectPublicId } from "./ids.js";
import { MAX_JOB_ATTEMPTS, SWEEP_BATCH_LIMIT } from "./constants.js";
import { emitRunLifecycle } from "./handlers/runs.js";

export interface SweepSummary {
  requeued: number;
  timedOut: number;
  runsCompleted: number;
  runsFailed: number;
}

// The sweep acts on the platform's behalf, not a user's — a system actor.
const SWEEP_ACTOR: ActorContext = { subjectId: "system:state-sweep", subjectType: "system" };

/**
 * Run one sweep pass. Pure of the cron wiring (so it is unit-testable against a
 * fake executor): re-queue/timeout lapsed leases, reconcile affected runs, emit
 * job.failed (on timeout) and run.completed|failed events.
 */
export async function sweepLeases(
  executor: SqlExecutor,
  now: Date = new Date(),
): Promise<SweepSummary> {
  const repo = createStateRepository(executor);
  const summary: SweepSummary = { requeued: 0, timedOut: 0, runsCompleted: 0, runsFailed: 0 };

  const swept = await repo.sweepLapsedLeases(now, MAX_JOB_ATTEMPTS, SWEEP_BATCH_LIMIT);
  if (!swept.ok) return summary;

  // Emit job.failed for every timed-out job (a re-queue is not a failure).
  for (const item of swept.value) {
    if (item.outcome === "requeued") {
      summary.requeued += 1;
    } else {
      summary.timedOut += 1;
      await emitJobTimedOut(executor, item);
    }
  }

  // Reconcile each distinct affected run once; emit run lifecycle on terminal.
  const runRowIds = dedupeRunRowIds(swept.value);
  for (const { runId, orgId, projectId } of runRowIds) {
    const reconciled = await repo.reconcileRunStatus(asUuid(orgId), asUuid(projectId), asUuid(runId));
    if (reconciled.ok && reconciled.value.transitioned) {
      const terminal = reconciled.value.transitioned;
      if (terminal === "succeeded") summary.runsCompleted += 1;
      else summary.runsFailed += 1;
      await emitRunLifecycle(
        executor,
        generateRequestId(),
        SWEEP_ACTOR,
        asUuid(orgId),
        asUuid(projectId),
        reconciled.value.run as Run,
        terminal,
      );
    }
  }

  return summary;
}

function dedupeRunRowIds(
  swept: SweptJob[],
): Array<{ runId: string; orgId: string; projectId: string }> {
  const map = new Map<string, { runId: string; orgId: string; projectId: string }>();
  for (const { job } of swept) {
    map.set(job.runId, { runId: job.runId, orgId: job.orgId, projectId: job.projectId });
  }
  return [...map.values()];
}

async function emitJobTimedOut(executor: SqlExecutor, item: SweptJob): Promise<void> {
  const job = item.job;
  try {
    const events = createEventsRepository(executor);
    await events.appendEvent({
      id: generateUuid(),
      type: STATE_EVENT_TYPES.JOB_FAILED,
      version: 1,
      source: "state-worker",
      occurredAt: new Date(),
      actorType: SWEEP_ACTOR.subjectType,
      actorId: SWEEP_ACTOR.subjectId,
      orgId: asUuid(job.orgId),
      projectId: asUuid(job.projectId),
      subjectKind: "run_job",
      subjectId: `${job.runId}:${job.jobId}`,
      subjectName: job.jobId,
      requestId: generateRequestId(),
      payload: {
        version: 1,
        runId: job.runId,
        jobId: job.jobId,
        orgId: orgPublicId(job.orgId),
        projectId: projectPublicId(job.projectId),
        reason: "timed_out",
        errorText: job.errorText ?? null,
      },
    });
  } catch {
    // Best-effort.
  }
}

/**
 * Cron entrypoint: open an executor, run a pass, dispose. Safe no-op when the
 * DB binding is absent (dormant deploys).
 */
export async function runSweep(env: Env): Promise<SweepSummary | null> {
  if (!env.PLATFORM_DB) return null;
  const { createSqlExecutor } = await import("@saas/db/hyperdrive");
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    return await sweepLeases(executor);
  } finally {
    if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
