// Run projection (BM3 — coordination-api.md §2 reads, §8.5). The pure mapping
// from the authoritative fold to the delayed read model: run summary + per-job
// rows + job counts. The DO's outbox feeds these into Postgres (the projector,
// the runtime shell), and the console/CLI read them — but the mapping itself is
// pure, so it is unit-tested here against the same fold golden vectors. Postgres
// is a projection of this; never a second source of truth.

import type { JobPhase, RunFoldState, RunPhase } from "./coordination.js";
import type { RunJobCounts } from "./state.js";

export interface RunProjection {
  runId: string;
  planDigest: string | null;
  sourceHash: string | null;
  phase: RunPhase;
  jobCounts: RunJobCounts;
  lastSeq: number;
}

export interface JobProjection {
  jobId: string;
  phase: JobPhase;
  holder: string | null;
  attempt: number;
  leaseExpiresAt: string | null;
  resultDigest: string | null;
  errorText: string | null;
}

export interface RunProjectionResult {
  run: RunProjection;
  jobs: JobProjection[];
}

/** Bucket a job phase into the four read-model counters the console renders. */
function countBucket(phase: JobPhase): keyof RunJobCounts {
  switch (phase) {
    case "queued":
      return "queued";
    case "claimed":
      return "running";
    case "succeeded":
    case "memoized":
      return "succeeded";
    case "failed":
    case "timed_out":
    case "canceled":
      return "failed";
  }
}

/**
 * Project a folded run state into the read model (run summary + sorted job rows
 * + counts). Pure and deterministic: jobs are emitted in jobId order so the
 * projection is stable regardless of map iteration order.
 */
export function projectRun(state: RunFoldState): RunProjectionResult {
  const counts: RunJobCounts = { queued: 0, running: 0, succeeded: 0, failed: 0 };
  const jobs: JobProjection[] = [];

  for (const jobId of Object.keys(state.jobs).sort()) {
    const j = state.jobs[jobId]!;
    counts[countBucket(j.phase)] += 1;
    jobs.push({
      jobId: j.jobId,
      phase: j.phase,
      holder: j.holder,
      attempt: j.attempt,
      leaseExpiresAt: j.leaseExpiresAt,
      resultDigest: j.resultDigest,
      errorText: j.errorText,
    });
  }

  return {
    run: {
      runId: state.runId,
      planDigest: state.planDigest,
      sourceHash: state.sourceHash,
      phase: state.phase,
      jobCounts: counts,
      lastSeq: state.lastSeq,
    },
    jobs,
  };
}
