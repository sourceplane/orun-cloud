// Run projector — decision layer (BM3 — coordination-api.md §2, design §8.5).
// The pure seam between the event-sourced fold vocabulary and the relational
// read model: it maps a folded run into read-model row writes and gates them on
// a per-run high-water mark so the projection is idempotent under replay and
// out-of-order delivery. The runtime shell (the DO outbox → Postgres consumer)
// applies these writes via a single seq-guarded UPSERT; the *what to write* and
// *whether to write* live here, pure and unit-tested, like the deciders.

import type { JobPhase, RunFoldState } from "./coordination.js";
import { projectRun } from "./coordination-projection.js";
import type { RunJobCounts, RunJobStatus, RunStatus } from "./state.js";

/** Read-model run row the projector wants persisted (status ≡ RunPhase). */
export interface RunRowWrite {
  runId: string;
  planDigest: string | null;
  sourceHash: string | null;
  status: RunStatus;
  jobCounts: RunJobCounts;
  /** High-water mark; the apply UPSERT guards `WHERE last_seq < lastSeq`. */
  lastSeq: number;
}

/** Read-model job row the projector wants persisted. */
export interface JobRowWrite {
  jobId: string;
  status: RunJobStatus;
  holder: string | null;
  attempt: number;
  leaseExpiresAt: string | null;
  resultDigest: string | null;
  errorText: string | null;
}

/**
 * A projection step. `apply:false` means the fold is not newer than what the
 * read model already reflects (`appliedSeq`) — an idempotent no-op (replay or
 * redelivery). `apply:true` carries the row writes and the new high-water mark.
 */
export interface ProjectionPlan {
  apply: boolean;
  toSeq: number;
  run?: RunRowWrite;
  jobs?: JobRowWrite[];
}

// The read model has no `memoized` bucket — a memo hit is a success — and never
// observes the fold's transient states beyond these. Exhaustive over JobPhase.
const JOB_STATUS: Record<JobPhase, RunJobStatus> = {
  queued: "queued",
  claimed: "claimed",
  succeeded: "succeeded",
  memoized: "succeeded",
  failed: "failed",
  timed_out: "timed_out",
  canceled: "canceled",
};

/**
 * Plan the read-model writes for a folded run against the seq already applied.
 * Pure and deterministic: jobs come out in jobId order (via projectRun), and the
 * seq gate makes redelivery and replay no-ops. `appliedSeq` is the projector's
 * stored high-water mark for the run (0 if never projected).
 */
export function planProjection(state: RunFoldState, appliedSeq: number): ProjectionPlan {
  if (state.lastSeq <= appliedSeq) {
    return { apply: false, toSeq: appliedSeq };
  }
  const { run, jobs } = projectRun(state);
  return {
    apply: true,
    toSeq: run.lastSeq,
    run: {
      runId: run.runId,
      planDigest: run.planDigest,
      sourceHash: run.sourceHash,
      status: run.phase,
      jobCounts: run.jobCounts,
      lastSeq: run.lastSeq,
    },
    jobs: jobs.map((j) => ({
      jobId: j.jobId,
      status: JOB_STATUS[j.phase],
      holder: j.holder,
      attempt: j.attempt,
      leaseExpiresAt: j.leaseExpiresAt,
      resultDigest: j.resultDigest,
      errorText: j.errorText,
    })),
  };
}
