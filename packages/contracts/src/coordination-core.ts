// Coordinator decision core (BM2 — coordination-api.md §3). The pure heart of
// the per-run coordinator: given the current folded run state, decide which
// event(s) to append for a claim / heartbeat / complete / cancel, or reject.
// The Durable Object is the durable, single-threaded shell that folds its log,
// calls these deciders, and appends the result — so "exactly one claim wins" is
// the DO's serialization applied to these pure decisions. Everything here is
// pure (time and lease tunables are parameters), so the parity invariants
// (concurrent-claim, takeover, deps cascade, timeout, memoization) are unit-
// testable without the Workers runtime.

import {
  COORDINATION_EVENT_TYPES as K,
  deriveRunPhase,
  type CoordinationPlan,
  type JobClaimedPayload,
  type JobFailedPayload,
  type JobMemoizedPayload,
  type JobPhase,
  type JobReadyPayload,
  type JobSucceededPayload,
  type LeaseExpiredPayload,
  type LeaseRenewedPayload,
  type RunFoldState,
  type RunTerminalPayload,
} from "./coordination.js";

export const DEFAULT_LEASE_SECONDS = 60;
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 20;
export const DEFAULT_MAX_JOB_ATTEMPTS = 5;

/** An event the DO should append (it assigns seq/at/actor/idempotencyKey). */
export type AppendIntent =
  | { kind: typeof K.JOB_CLAIMED; jobId: string; payload: JobClaimedPayload }
  | { kind: typeof K.LEASE_EXPIRED; jobId: string; payload: LeaseExpiredPayload }
  | { kind: typeof K.LEASE_RENEWED; jobId: string; payload: LeaseRenewedPayload }
  | { kind: typeof K.JOB_SUCCEEDED; jobId: string; payload: JobSucceededPayload }
  | { kind: typeof K.JOB_MEMOIZED; jobId: string; payload: JobMemoizedPayload }
  | { kind: typeof K.JOB_FAILED; jobId: string; payload: JobFailedPayload }
  | { kind: typeof K.JOB_READY; jobId: string; payload: JobReadyPayload }
  | { kind: typeof K.RUN_COMPLETED; payload: RunTerminalPayload }
  | { kind: typeof K.RUN_FAILED; payload: RunTerminalPayload }
  | { kind: typeof K.RUN_CANCELED; payload: RunTerminalPayload };

export type RejectReason =
  | "not_found"
  | "deps_not_ready"
  | "job_held"
  | "terminal"
  | "lease_lost"
  | "run_terminal";

export type Decision =
  | { ok: true; appends: AppendIntent[]; cached?: boolean }
  | { ok: false; reason: RejectReason };

export interface LeaseConfig {
  leaseSeconds?: number;
  maxAttempts?: number;
}

function leaseExpiry(now: string, leaseSeconds: number): string {
  return new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
}

function leaseExpired(leaseExpiresAt: string | null, now: string): boolean {
  if (!leaseExpiresAt) return true;
  return Date.parse(leaseExpiresAt) <= Date.parse(now);
}

/**
 * Run-terminal *signal* (coordination-api.md §3): when a job-terminal transition
 * makes the whole run terminal, emit a `RUN_COMPLETED`/`RUN_FAILED` event so the
 * event log is self-describing for stream consumers (SSE, provenance). These are
 * projection signals, not authority — the fold still derives the run phase from
 * job phases — so emitting them is idempotent and the read model is unchanged.
 *
 * `overrides` maps jobId → the post-append phase for the jobs this verb is about
 * to transition. We only emit on the *transition* into a terminal phase (guarded
 * on the pre-append run phase) so a second failing job never re-emits RUN_FAILED.
 */
function runTerminalAppends(
  state: RunFoldState,
  overrides: Record<string, JobPhase>,
  failReason: string | null = "job_failed",
): AppendIntent[] {
  // Already terminal (or never created) ⇒ no transition to signal.
  if (state.phase === "succeeded" || state.phase === "failed" || state.phase === "canceled") return [];
  const jobs: Record<string, { phase: JobPhase; attempt: number }> = {};
  for (const [id, j] of Object.entries(state.jobs)) {
    jobs[id] = { phase: overrides[id] ?? j.phase, attempt: j.attempt };
  }
  const phase = deriveRunPhase(jobs as RunFoldState["jobs"], false, true);
  if (phase === "succeeded") return [{ kind: K.RUN_COMPLETED, payload: { reason: null } }];
  if (phase === "failed") return [{ kind: K.RUN_FAILED, payload: { reason: failReason } }];
  return [];
}

function depsSatisfied(state: RunFoldState, plan: CoordinationPlan, jobId: string): boolean {
  const deps = plan.jobs[jobId]?.deps ?? [];
  return deps.every((d) => {
    const dep = state.jobs[d];
    return dep !== undefined && (dep.phase === "succeeded" || dep.phase === "memoized");
  });
}

export interface ClaimRequest {
  jobId: string;
  runnerId: string;
  /** Plan marks the job hermetic → memoization is consulted. */
  hermetic?: boolean;
  /** The digest of an existing `job-result` for this job's jobInputHash, if any. */
  memoResultDigest?: string | null;
}

/**
 * Decide a claim (coordination-api.md §3): wins only if the job is claimable in
 * the current state (queued with deps satisfied, or a claimed job whose lease
 * has lapsed → takeover). A hermetic job with an existing result is memoized.
 */
export function decideClaim(
  state: RunFoldState,
  plan: CoordinationPlan,
  req: ClaimRequest,
  now: string,
  cfg: LeaseConfig = {},
): Decision {
  const leaseSeconds = cfg.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const job = state.jobs[req.jobId];
  if (job === undefined) return { ok: false, reason: "not_found" };

  if (job.phase === "succeeded" || job.phase === "memoized") return { ok: false, reason: "terminal" };
  if (job.phase === "failed" || job.phase === "timed_out" || job.phase === "canceled") {
    return { ok: false, reason: "terminal" };
  }

  if (!depsSatisfied(state, plan, req.jobId)) return { ok: false, reason: "deps_not_ready" };

  if (job.phase === "claimed") {
    if (!leaseExpired(job.leaseExpiresAt, now)) return { ok: false, reason: "job_held" };
    // Takeover: the holder's lease lapsed. Re-queue (attempt+1) then re-claim.
    const attempt = job.attempt + 1;
    return {
      ok: true,
      appends: [
        { kind: K.LEASE_EXPIRED, jobId: req.jobId, payload: { runnerId: job.holder ?? "", leaseEpoch: job.leaseEpoch ?? 0 } },
        {
          kind: K.JOB_CLAIMED,
          jobId: req.jobId,
          payload: { runnerId: req.runnerId, leaseEpoch: attempt, leaseExpiresAt: leaseExpiry(now, leaseSeconds), attempt },
        },
      ],
    };
  }

  // queued and runnable.
  if (req.hermetic && req.memoResultDigest) {
    return {
      ok: true,
      cached: true,
      appends: [{ kind: K.JOB_MEMOIZED, jobId: req.jobId, payload: { resultDigest: req.memoResultDigest } }],
    };
  }
  const attempt = job.attempt;
  return {
    ok: true,
    appends: [
      {
        kind: K.JOB_CLAIMED,
        jobId: req.jobId,
        payload: { runnerId: req.runnerId, leaseEpoch: attempt, leaseExpiresAt: leaseExpiry(now, leaseSeconds), attempt },
      },
    ],
  };
}

export interface LeaseRequest {
  jobId: string;
  runnerId: string;
  leaseEpoch: number;
}

/** Decide a heartbeat: only the current holder of the current lease may renew. */
export function decideHeartbeat(
  state: RunFoldState,
  req: LeaseRequest,
  now: string,
  cfg: LeaseConfig = {},
): Decision {
  const leaseSeconds = cfg.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const job = state.jobs[req.jobId];
  if (job === undefined) return { ok: false, reason: "not_found" };
  if (job.phase !== "claimed" || job.holder !== req.runnerId || job.leaseEpoch !== req.leaseEpoch) {
    return { ok: false, reason: "lease_lost" };
  }
  return {
    ok: true,
    appends: [
      { kind: K.LEASE_RENEWED, jobId: req.jobId, payload: { runnerId: req.runnerId, leaseEpoch: req.leaseEpoch, leaseExpiresAt: leaseExpiry(now, leaseSeconds) } },
    ],
  };
}

export interface CompleteRequest {
  jobId: string;
  runnerId: string;
  leaseEpoch: number;
  outcome: "succeeded" | "failed";
  resultDigest?: string;
  /** Digest of the sealed `log` object (§4), set by the worker after assembling
   *  the job's log chunks. Recorded on the JobSucceeded event when present. */
  logsDigest?: string;
  reason?: string;
  errorText?: string;
}

/** Decide a terminal transition: only the lease holder may complete its job. */
export function decideComplete(state: RunFoldState, req: CompleteRequest): Decision {
  const job = state.jobs[req.jobId];
  if (job === undefined) return { ok: false, reason: "not_found" };
  if (job.phase === "succeeded" || job.phase === "memoized" || job.phase === "failed" || job.phase === "timed_out" || job.phase === "canceled") {
    return { ok: false, reason: "terminal" };
  }
  if (job.phase !== "claimed" || job.holder !== req.runnerId || job.leaseEpoch !== req.leaseEpoch) {
    return { ok: false, reason: "lease_lost" };
  }
  if (req.outcome === "succeeded") {
    return {
      ok: true,
      appends: [
        {
          kind: K.JOB_SUCCEEDED,
          jobId: req.jobId,
          payload: {
            runnerId: req.runnerId,
            leaseEpoch: req.leaseEpoch,
            resultDigest: req.resultDigest ?? "",
            ...(req.logsDigest ? { logsDigest: req.logsDigest } : {}),
          },
        },
        ...runTerminalAppends(state, { [req.jobId]: "succeeded" }),
      ],
    };
  }
  const reason = req.reason ?? "step_failed";
  // The fold maps a `timed_out` reason to the timed_out phase; any other reason → failed.
  const failedPhase: JobPhase = reason === "timed_out" ? "timed_out" : "failed";
  return {
    ok: true,
    appends: [
      { kind: K.JOB_FAILED, jobId: req.jobId, payload: { runnerId: req.runnerId, leaseEpoch: req.leaseEpoch, reason, errorText: req.errorText ?? null } },
      ...runTerminalAppends(state, { [req.jobId]: failedPhase }, reason),
    ],
  };
}

/** Decide a cancel: append RunCanceled unless the run is already terminal. */
export function decideCancel(state: RunFoldState): Decision {
  if (state.phase === "succeeded" || state.phase === "failed" || state.phase === "canceled") {
    return { ok: false, reason: "run_terminal" };
  }
  return { ok: true, appends: [{ kind: K.RUN_CANCELED, payload: { reason: "canceled" } }] };
}

/**
 * The lease sweep (BM2, replacing the cron): for each claimed job whose lease
 * has lapsed, re-queue it (LeaseExpired → attempt+1) unless it has exhausted its
 * attempts, in which case fail it (timed_out). Driven by the DO alarm.
 */
export function sweepLeases(
  state: RunFoldState,
  now: string,
  cfg: LeaseConfig = {},
): AppendIntent[] {
  const maxAttempts = cfg.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS;
  const appends: AppendIntent[] = [];
  // Post-sweep phase overrides, so a timeout that drains the run emits RUN_FAILED.
  const overrides: Record<string, JobPhase> = {};
  for (const job of Object.values(state.jobs)) {
    if (job.phase !== "claimed") continue;
    if (!leaseExpired(job.leaseExpiresAt, now)) continue;
    if (job.attempt >= maxAttempts) {
      appends.push({ kind: K.JOB_FAILED, jobId: job.jobId, payload: { runnerId: job.holder, leaseEpoch: job.leaseEpoch, reason: "timed_out", errorText: "runner heartbeat timeout" } });
      overrides[job.jobId] = "timed_out";
    } else {
      appends.push({ kind: K.LEASE_EXPIRED, jobId: job.jobId, payload: { runnerId: job.holder ?? "", leaseEpoch: job.leaseEpoch ?? 0 } });
      overrides[job.jobId] = "queued"; // re-queued — non-terminal
    }
  }
  // A sweep only re-queues or times-out jobs, so it can transition the run to
  // failed (a timed_out job) but never to succeeded. Emit the signal once.
  appends.push(...runTerminalAppends(state, overrides, "timed_out"));
  return appends;
}
