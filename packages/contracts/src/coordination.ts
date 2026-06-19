// Coordination v2 — event-sourced run coordination (saas-orun-backend-merge
// `coordination-api.md` §8). This module is the **normative, shared** heart of
// the contract: the append-only per-run event log shape (§8.1) and the pure
// `reduce()` fold (§8.2) that the server, the projector, and the CLI all agree
// on. The CLI ports `reduce()` to Go; the two are pinned by the golden vectors
// in `coordination-vectors.ts`, run in both repos' CIs.
//
// Authoritative job/lease state is a deterministic left-fold by `seq`. Postgres
// is a delayed projection of this same fold — never a second source of truth.

// ── Actors ──────────────────────────────────────────────────

export type CoordinationActorType =
  | "user"
  | "service_principal"
  | "workflow"
  | "system";

export interface CoordinationActor {
  id: string;
  type: CoordinationActorType;
}

// ── Event kinds (dotted, aligned with the `state.*` taxonomy) ─

export const COORDINATION_EVENT_TYPES = {
  RUN_CREATED: "state.run.created",
  JOB_READY: "state.job.ready",
  JOB_CLAIMED: "state.job.claimed",
  LEASE_RENEWED: "state.job.lease_renewed",
  LEASE_EXPIRED: "state.job.lease_expired",
  JOB_SUCCEEDED: "state.job.succeeded",
  JOB_MEMOIZED: "state.job.memoized",
  JOB_FAILED: "state.job.failed",
  LOG_CHUNK: "state.job.log_chunk",
  RUN_COMPLETED: "state.run.completed",
  RUN_FAILED: "state.run.failed",
  RUN_CANCELED: "state.run.canceled",
} as const;

export type CoordinationEventType =
  (typeof COORDINATION_EVENT_TYPES)[keyof typeof COORDINATION_EVENT_TYPES];

// ── Envelope (C1 / §8.1) ────────────────────────────────────

interface EventEnvelope<K extends CoordinationEventType, P> {
  /** Gap-free monotonic per run, assigned by the single writer. */
  seq: number;
  kind: K;
  runId: string;
  /** Omitted for run-level events. */
  jobId?: string;
  actor: CoordinationActor;
  /** ISO-8601 instant. */
  at: string;
  /** `(jobId,kind,leaseEpoch)` for coordination events; client ULID for RunCreated. */
  idempotencyKey: string;
  /** Per-kind schema version; additive-only. */
  v: number;
  payload: P;
}

// ── Per-event payloads (versioned) ──────────────────────────

export interface RunCreatedPayload {
  planDigest: string;
  sourceHash: string;
  environment: string | null;
}
export interface JobReadyPayload {
  attempt: number;
}
export interface JobClaimedPayload {
  runnerId: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
  attempt: number;
}
export interface LeaseRenewedPayload {
  runnerId: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
}
export interface LeaseExpiredPayload {
  runnerId: string;
  leaseEpoch: number;
}
export interface JobSucceededPayload {
  runnerId: string;
  leaseEpoch: number;
  resultDigest: string;
}
export interface JobMemoizedPayload {
  resultDigest: string;
}
export interface JobFailedPayload {
  runnerId: string | null;
  leaseEpoch: number | null;
  /** e.g. "timed_out" | "step_failed" | "canceled". */
  reason: string;
  errorText: string | null;
}
export interface LogChunkPayload {
  runnerId: string;
  /** Per-(job) chunk sequence; bytes live in the object/log plane, not here. */
  chunkSeq: number;
}
export interface RunTerminalPayload {
  reason: string | null;
}

// ── The event union ─────────────────────────────────────────

export type CoordinationEvent =
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.RUN_CREATED, RunCreatedPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.JOB_READY, JobReadyPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.JOB_CLAIMED, JobClaimedPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.LEASE_RENEWED, LeaseRenewedPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.LEASE_EXPIRED, LeaseExpiredPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.JOB_SUCCEEDED, JobSucceededPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.JOB_MEMOIZED, JobMemoizedPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.JOB_FAILED, JobFailedPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.LOG_CHUNK, LogChunkPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.RUN_COMPLETED, RunTerminalPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.RUN_FAILED, RunTerminalPayload>
  | EventEnvelope<typeof COORDINATION_EVENT_TYPES.RUN_CANCELED, RunTerminalPayload>;

// ── The fold result (§8.2) ──────────────────────────────────

export type JobPhase =
  | "queued"
  | "claimed"
  | "succeeded"
  | "memoized"
  | "failed"
  | "timed_out"
  | "canceled";

export type RunPhase = "pending" | "running" | "succeeded" | "failed" | "canceled";

export interface JobFoldState {
  jobId: string;
  phase: JobPhase;
  holder: string | null;
  leaseEpoch: number | null;
  leaseExpiresAt: string | null;
  attempt: number;
  resultDigest: string | null;
  errorText: string | null;
}

export interface RunFoldState {
  runId: string;
  planDigest: string | null;
  sourceHash: string | null;
  phase: RunPhase;
  jobs: Record<string, JobFoldState>;
  /** queued jobs whose every dep is succeeded|memoized, sorted by jobId asc. */
  frontier: string[];
  lastSeq: number;
}

/** The plan-derived job DAG the fold needs (jobs are not carried in events). */
export interface CoordinationPlan {
  jobs: Record<string, { deps: string[] }>;
}

const JOB_TERMINAL: ReadonlySet<JobPhase> = new Set([
  "succeeded",
  "memoized",
  "failed",
  "timed_out",
  "canceled",
]);

function isJobSuccess(phase: JobPhase): boolean {
  return phase === "succeeded" || phase === "memoized";
}

function freshJob(jobId: string): JobFoldState {
  return {
    jobId,
    phase: "queued",
    holder: null,
    leaseEpoch: null,
    leaseExpiresAt: null,
    attempt: 1,
    resultDigest: null,
    errorText: null,
  };
}

/**
 * Deterministic left-fold of a run's event stream into authoritative state
 * (§8.2). Pure: identical (events, plan) always yield an identical result.
 * Events are sorted by `seq` defensively; unknown kinds are ignored (additive
 * forward-compat). Run phase and the runnable frontier are *derived* from job
 * phases — `RUN_COMPLETED`/`RUN_FAILED` are projection signals, not authority;
 * `RUN_CANCELED` is honored (cancels non-terminal jobs).
 */
export function reduce(
  events: readonly CoordinationEvent[],
  plan: CoordinationPlan,
): RunFoldState {
  const jobs: Record<string, JobFoldState> = {};
  for (const jobId of Object.keys(plan.jobs)) {
    jobs[jobId] = freshJob(jobId);
  }

  let planDigest: string | null = null;
  let sourceHash: string | null = null;
  let runId = "";
  let lastSeq = 0;
  let canceled = false;

  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of ordered) {
    lastSeq = Math.max(lastSeq, e.seq);
    if (runId === "") runId = e.runId;

    if (e.kind === COORDINATION_EVENT_TYPES.RUN_CREATED) {
      planDigest = e.payload.planDigest;
      sourceHash = e.payload.sourceHash;
      continue;
    }
    if (e.kind === COORDINATION_EVENT_TYPES.RUN_CANCELED) {
      canceled = true;
      for (const job of Object.values(jobs)) {
        if (!JOB_TERMINAL.has(job.phase)) {
          job.phase = "canceled";
          job.holder = null;
          job.leaseEpoch = null;
          job.leaseExpiresAt = null;
        }
      }
      continue;
    }
    // Remaining authoritative events are job-scoped.
    if (e.jobId === undefined) continue;
    const job = jobs[e.jobId];
    if (job === undefined) continue; // event for a job not in the plan — ignore
    if (JOB_TERMINAL.has(job.phase) && e.kind !== COORDINATION_EVENT_TYPES.JOB_READY) {
      continue; // terminal states are sticky
    }

    switch (e.kind) {
      case COORDINATION_EVENT_TYPES.JOB_READY:
        if (!JOB_TERMINAL.has(job.phase)) {
          job.phase = "queued";
          job.holder = null;
          job.leaseEpoch = null;
          job.leaseExpiresAt = null;
          job.attempt = e.payload.attempt;
        }
        break;
      case COORDINATION_EVENT_TYPES.JOB_CLAIMED:
        job.phase = "claimed";
        job.holder = e.payload.runnerId;
        job.leaseEpoch = e.payload.leaseEpoch;
        job.leaseExpiresAt = e.payload.leaseExpiresAt;
        job.attempt = e.payload.attempt;
        break;
      case COORDINATION_EVENT_TYPES.LEASE_RENEWED:
        if (job.holder === e.payload.runnerId && job.leaseEpoch === e.payload.leaseEpoch) {
          job.leaseExpiresAt = e.payload.leaseExpiresAt;
        }
        break;
      case COORDINATION_EVENT_TYPES.LEASE_EXPIRED:
        if (job.phase === "claimed" && job.leaseEpoch === e.payload.leaseEpoch) {
          job.phase = "queued";
          job.holder = null;
          job.leaseEpoch = null;
          job.leaseExpiresAt = null;
          job.attempt += 1;
        }
        break;
      case COORDINATION_EVENT_TYPES.JOB_SUCCEEDED:
        job.phase = "succeeded";
        job.resultDigest = e.payload.resultDigest;
        job.holder = null;
        job.leaseEpoch = null;
        job.leaseExpiresAt = null;
        break;
      case COORDINATION_EVENT_TYPES.JOB_MEMOIZED:
        job.phase = "memoized";
        job.resultDigest = e.payload.resultDigest;
        job.holder = null;
        job.leaseEpoch = null;
        job.leaseExpiresAt = null;
        break;
      case COORDINATION_EVENT_TYPES.JOB_FAILED:
        job.phase = e.payload.reason === "timed_out" ? "timed_out" : "failed";
        job.errorText = e.payload.errorText;
        job.holder = null;
        job.leaseEpoch = null;
        job.leaseExpiresAt = null;
        break;
      default:
        break; // LOG_CHUNK and unknown kinds do not change fold state
    }
  }

  return {
    runId,
    planDigest,
    sourceHash,
    phase: deriveRunPhase(jobs, canceled, planDigest !== null),
    jobs,
    frontier: computeFrontier(jobs, plan),
    lastSeq,
  };
}

function deriveRunPhase(
  jobs: Record<string, JobFoldState>,
  canceled: boolean,
  created: boolean,
): RunPhase {
  if (canceled) return "canceled";
  const all = Object.values(jobs);
  if (all.length === 0) return "pending";
  if (all.some((j) => j.phase === "failed" || j.phase === "timed_out")) return "failed";
  if (all.every((j) => isJobSuccess(j.phase))) return "succeeded";
  // A created run is "running" until it reaches a terminal state; a run we have
  // not yet seen created (no RunCreated) but with in-flight work is also running.
  const active = all.some((j) => j.phase !== "queued" || j.attempt > 1);
  if (created || active) return "running";
  return "pending";
}

function computeFrontier(
  jobs: Record<string, JobFoldState>,
  plan: CoordinationPlan,
): string[] {
  const frontier: string[] = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    if (job.phase !== "queued") continue;
    const deps = plan.jobs[jobId]?.deps ?? [];
    const ready = deps.every((d) => {
      const dep = jobs[d];
      return dep !== undefined && isJobSuccess(dep.phase);
    });
    if (ready) frontier.push(jobId);
  }
  return frontier.sort();
}
