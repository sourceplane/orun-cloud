// Golden vectors for the coordination fold (`reduce()`), the cross-language
// contract per `coordination-api.md` §8.2. The CLI (Go) port of `reduce()` must
// reproduce every `expected` here for the same `(events, plan)`. Keep these
// serializable in spirit (plain data via small builders) so the Go side can
// mirror them verbatim.

import {
  COORDINATION_EVENT_TYPES as K,
  type CoordinationActor,
  type CoordinationEvent,
  type CoordinationPlan,
  type JobFoldState,
  type RunFoldState,
} from "./coordination.js";

const A: CoordinationActor = { id: "u1", type: "user" };
const AT = "2026-06-19T00:00:00Z";
const LE = "2026-06-19T00:01:00Z";

// ── event builders ──────────────────────────────────────────

function created(seq: number): CoordinationEvent {
  return {
    seq,
    kind: K.RUN_CREATED,
    runId: "r",
    actor: A,
    at: AT,
    idempotencyKey: "r",
    v: 1,
    payload: { planDigest: "sha256:plan", sourceHash: "sha256:src", environment: "production" },
  };
}
function claimed(seq: number, jobId: string, leaseEpoch = 1, attempt = 1): CoordinationEvent {
  return {
    seq,
    kind: K.JOB_CLAIMED,
    runId: "r",
    jobId,
    actor: A,
    at: AT,
    idempotencyKey: `${jobId}:${K.JOB_CLAIMED}:${leaseEpoch}`,
    v: 1,
    payload: { runnerId: "runner-1", leaseEpoch, leaseExpiresAt: LE, attempt },
  };
}
function succeeded(seq: number, jobId: string, resultDigest: string, leaseEpoch = 1): CoordinationEvent {
  return {
    seq,
    kind: K.JOB_SUCCEEDED,
    runId: "r",
    jobId,
    actor: A,
    at: AT,
    idempotencyKey: `${jobId}:${K.JOB_SUCCEEDED}:${leaseEpoch}`,
    v: 1,
    payload: { runnerId: "runner-1", leaseEpoch, resultDigest },
  };
}
function memoized(seq: number, jobId: string, resultDigest: string): CoordinationEvent {
  return {
    seq,
    kind: K.JOB_MEMOIZED,
    runId: "r",
    jobId,
    actor: A,
    at: AT,
    idempotencyKey: `${jobId}:${K.JOB_MEMOIZED}:0`,
    v: 1,
    payload: { resultDigest },
  };
}
function failed(seq: number, jobId: string, reason: string, errorText: string, leaseEpoch = 1): CoordinationEvent {
  return {
    seq,
    kind: K.JOB_FAILED,
    runId: "r",
    jobId,
    actor: A,
    at: AT,
    idempotencyKey: `${jobId}:${K.JOB_FAILED}:${leaseEpoch}`,
    v: 1,
    payload: { runnerId: "runner-1", leaseEpoch, reason, errorText },
  };
}
function leaseExpired(seq: number, jobId: string, leaseEpoch = 1): CoordinationEvent {
  return {
    seq,
    kind: K.LEASE_EXPIRED,
    runId: "r",
    jobId,
    actor: { id: "system:state-sweep", type: "system" },
    at: AT,
    idempotencyKey: `${jobId}:${K.LEASE_EXPIRED}:${leaseEpoch}`,
    v: 1,
    payload: { runnerId: "runner-1", leaseEpoch },
  };
}
function canceled(seq: number): CoordinationEvent {
  return {
    seq,
    kind: K.RUN_CANCELED,
    runId: "r",
    actor: A,
    at: AT,
    idempotencyKey: `r:${K.RUN_CANCELED}:0`,
    v: 1,
    payload: { reason: "user" },
  };
}

// ── expected-state builder ──────────────────────────────────

function j(jobId: string, over: Partial<JobFoldState> = {}): JobFoldState {
  return {
    jobId,
    phase: "queued",
    holder: null,
    leaseEpoch: null,
    leaseExpiresAt: null,
    attempt: 1,
    resultDigest: null,
    errorText: null,
    ...over,
  };
}

export interface FoldVector {
  name: string;
  plan: CoordinationPlan;
  events: CoordinationEvent[];
  expected: RunFoldState;
}

const LINEAR: CoordinationPlan = { jobs: { a: { deps: [] }, b: { deps: ["a"] } } };
const DIAMOND: CoordinationPlan = {
  jobs: { a: { deps: [] }, b: { deps: ["a"] }, c: { deps: ["a"] }, d: { deps: ["b", "c"] } },
};

export const COORDINATION_FOLD_VECTORS: FoldVector[] = [
  {
    name: "empty stream — initial frontier is the deps-free jobs",
    plan: LINEAR,
    events: [],
    expected: {
      runId: "",
      planDigest: null,
      sourceHash: null,
      phase: "pending",
      jobs: { a: j("a"), b: j("b") },
      frontier: ["a"],
      lastSeq: 0,
    },
  },
  {
    name: "created + claim a — a held, b still blocked, run running",
    plan: LINEAR,
    events: [created(1), claimed(2, "a")],
    expected: {
      runId: "r",
      planDigest: "sha256:plan",
      sourceHash: "sha256:src",
      phase: "running",
      jobs: {
        a: j("a", { phase: "claimed", holder: "runner-1", leaseEpoch: 1, leaseExpiresAt: LE }),
        b: j("b"),
      },
      frontier: [],
      lastSeq: 2,
    },
  },
  {
    name: "a succeeds — unblocks b into the frontier",
    plan: LINEAR,
    events: [created(1), claimed(2, "a"), succeeded(3, "a", "sha256:res-a")],
    expected: {
      runId: "r",
      planDigest: "sha256:plan",
      sourceHash: "sha256:src",
      phase: "running",
      jobs: {
        a: j("a", { phase: "succeeded", resultDigest: "sha256:res-a" }),
        b: j("b"),
      },
      frontier: ["b"],
      lastSeq: 3,
    },
  },
  {
    name: "out-of-order seq is sorted defensively (same as created+claim)",
    plan: LINEAR,
    events: [claimed(2, "a"), created(1)],
    expected: {
      runId: "r",
      planDigest: "sha256:plan",
      sourceHash: "sha256:src",
      phase: "running",
      jobs: {
        a: j("a", { phase: "claimed", holder: "runner-1", leaseEpoch: 1, leaseExpiresAt: LE }),
        b: j("b"),
      },
      frontier: [],
      lastSeq: 2,
    },
  },
  {
    name: "diamond runs to completion — run succeeded, empty frontier",
    plan: DIAMOND,
    events: [
      created(1),
      claimed(2, "a"),
      succeeded(3, "a", "sha256:res-a"),
      claimed(4, "b"),
      claimed(5, "c"),
      succeeded(6, "b", "sha256:res-b"),
      succeeded(7, "c", "sha256:res-c"),
      claimed(8, "d"),
      succeeded(9, "d", "sha256:res-d"),
    ],
    expected: {
      runId: "r",
      planDigest: "sha256:plan",
      sourceHash: "sha256:src",
      phase: "succeeded",
      jobs: {
        a: j("a", { phase: "succeeded", resultDigest: "sha256:res-a" }),
        b: j("b", { phase: "succeeded", resultDigest: "sha256:res-b" }),
        c: j("c", { phase: "succeeded", resultDigest: "sha256:res-c" }),
        d: j("d", { phase: "succeeded", resultDigest: "sha256:res-d" }),
      },
      frontier: [],
      lastSeq: 9,
    },
  },
  {
    name: "failed dependency blocks downstream and fails the run",
    plan: LINEAR,
    events: [created(1), claimed(2, "a"), failed(3, "a", "step_failed", "boom")],
    expected: {
      runId: "r",
      planDigest: "sha256:plan",
      sourceHash: "sha256:src",
      phase: "failed",
      jobs: {
        a: j("a", { phase: "failed", errorText: "boom" }),
        b: j("b"),
      },
      frontier: [],
      lastSeq: 3,
    },
  },
  {
    name: "lease expiry re-queues the job (attempt+1) back into the frontier",
    plan: { jobs: { a: { deps: [] } } },
    events: [created(1), claimed(2, "a"), leaseExpired(3, "a")],
    expected: {
      runId: "r",
      planDigest: "sha256:plan",
      sourceHash: "sha256:src",
      phase: "running",
      jobs: { a: j("a", { attempt: 2 }) },
      frontier: ["a"],
      lastSeq: 3,
    },
  },
  {
    name: "memoized job counts as success and unblocks downstream",
    plan: LINEAR,
    events: [created(1), memoized(2, "a", "sha256:cached-a")],
    expected: {
      runId: "r",
      planDigest: "sha256:plan",
      sourceHash: "sha256:src",
      phase: "running",
      jobs: {
        a: j("a", { phase: "memoized", resultDigest: "sha256:cached-a" }),
        b: j("b"),
      },
      frontier: ["b"],
      lastSeq: 2,
    },
  },
  {
    name: "cancel marks non-terminal jobs canceled and the run canceled",
    plan: LINEAR,
    events: [created(1), claimed(2, "a"), canceled(3)],
    expected: {
      runId: "r",
      planDigest: "sha256:plan",
      sourceHash: "sha256:src",
      phase: "canceled",
      jobs: {
        a: j("a", { phase: "canceled" }),
        b: j("b", { phase: "canceled" }),
      },
      frontier: [],
      lastSeq: 3,
    },
  },
];
