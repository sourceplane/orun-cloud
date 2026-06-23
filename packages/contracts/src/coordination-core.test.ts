import { describe, expect, it } from "vitest";

import {
  COORDINATION_EVENT_TYPES as K,
  reduce,
  type CoordinationEvent,
  type CoordinationPlan,
  type RunFoldState,
} from "./coordination.js";
import {
  decideCancel,
  decideClaim,
  decideComplete,
  decideHeartbeat,
  sweepLeases,
  type AppendIntent,
} from "./coordination-core.js";

const T0 = "2026-06-19T00:00:00Z";
const T_LATE = "2026-06-19T00:02:00Z"; // past a 60s lease taken at T0
const SYS = { id: "sys", type: "system" as const };

function ev(seq: number, kind: string, jobId: string | undefined, payload: unknown): CoordinationEvent {
  return {
    seq, kind, runId: "r", jobId, actor: SYS, at: T0, idempotencyKey: String(seq), v: 1, payload,
  } as CoordinationEvent;
}

// A tiny simulator of the DO's serialized append loop: decide → finalize → fold.
class Sim {
  events: CoordinationEvent[] = [];
  seq = 0;
  constructor(public plan: CoordinationPlan, created = true) {
    if (created) {
      this.push(ev(++this.seq, K.RUN_CREATED, undefined, { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null }));
    }
  }
  push(e: CoordinationEvent) {
    this.events.push(e);
  }
  apply(intents: AppendIntent[]) {
    for (const i of intents) {
      this.push(ev(++this.seq, i.kind, "jobId" in i ? i.jobId : undefined, i.payload));
    }
  }
  state(): RunFoldState {
    return reduce(this.events, this.plan);
  }
}

const linear: CoordinationPlan = { jobs: { a: { deps: [] }, b: { deps: ["a"] } } };

describe("decideClaim — exactly one winner", () => {
  it("a second concurrent claim on a held job is rejected (job_held)", () => {
    const sim = new Sim(linear);
    const d1 = decideClaim(sim.state(), linear, { jobId: "a", runnerId: "r1" }, T0);
    expect(d1.ok).toBe(true);
    if (d1.ok) sim.apply(d1.appends);
    expect(sim.state().jobs.a!.holder).toBe("r1");

    const d2 = decideClaim(sim.state(), linear, { jobId: "a", runnerId: "r2" }, T0);
    expect(d2).toEqual({ ok: false, reason: "job_held" });
  });

  it("blocks a job whose deps are not satisfied, then allows it once they are", () => {
    const sim = new Sim(linear);
    expect(decideClaim(sim.state(), linear, { jobId: "b", runnerId: "r1" }, T0)).toEqual({ ok: false, reason: "deps_not_ready" });

    const c = decideClaim(sim.state(), linear, { jobId: "a", runnerId: "r1" }, T0);
    if (c.ok) sim.apply(c.appends);
    const done = decideComplete(sim.state(), { jobId: "a", runnerId: "r1", leaseEpoch: 1, outcome: "succeeded", resultDigest: "sha256:ra" });
    if (done.ok) sim.apply(done.appends);

    const d = decideClaim(sim.state(), linear, { jobId: "b", runnerId: "r1" }, T0);
    expect(d.ok).toBe(true);
  });
});

describe("decideClaim — takeover on lapsed lease", () => {
  it("re-queues then re-claims for a new runner, attempt+1", () => {
    const sim = new Sim(linear);
    const c = decideClaim(sim.state(), linear, { jobId: "a", runnerId: "r1" }, T0);
    if (c.ok) sim.apply(c.appends);

    const t = decideClaim(sim.state(), linear, { jobId: "a", runnerId: "r2" }, T_LATE);
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.appends.map((a) => a.kind)).toEqual([K.LEASE_EXPIRED, K.JOB_CLAIMED]);
      sim.apply(t.appends);
    }
    const a = sim.state().jobs.a!;
    expect(a.holder).toBe("r2");
    expect(a.attempt).toBe(2);
    expect(a.leaseEpoch).toBe(2);
  });
});

describe("decideHeartbeat", () => {
  it("renews for the holder and rejects a stale/foreign heartbeat", () => {
    const sim = new Sim(linear);
    const c = decideClaim(sim.state(), linear, { jobId: "a", runnerId: "r1" }, T0);
    if (c.ok) sim.apply(c.appends);

    expect(decideHeartbeat(sim.state(), { jobId: "a", runnerId: "r1", leaseEpoch: 1 }, T0).ok).toBe(true);
    expect(decideHeartbeat(sim.state(), { jobId: "a", runnerId: "r2", leaseEpoch: 1 }, T0)).toEqual({ ok: false, reason: "lease_lost" });

    // After a takeover, the old holder's heartbeat (epoch 1) is lease_lost.
    const t = decideClaim(sim.state(), linear, { jobId: "a", runnerId: "r2" }, T_LATE);
    if (t.ok) sim.apply(t.appends);
    expect(decideHeartbeat(sim.state(), { jobId: "a", runnerId: "r1", leaseEpoch: 1 }, T_LATE)).toEqual({ ok: false, reason: "lease_lost" });
  });
});

describe("decideComplete", () => {
  it("only the lease holder may complete; terminal is sticky", () => {
    const sim = new Sim(linear);
    const c = decideClaim(sim.state(), linear, { jobId: "a", runnerId: "r1" }, T0);
    if (c.ok) sim.apply(c.appends);

    expect(decideComplete(sim.state(), { jobId: "a", runnerId: "r2", leaseEpoch: 1, outcome: "succeeded" })).toEqual({ ok: false, reason: "lease_lost" });

    const ok = decideComplete(sim.state(), { jobId: "a", runnerId: "r1", leaseEpoch: 1, outcome: "succeeded", resultDigest: "sha256:ra" });
    expect(ok.ok).toBe(true);
    if (ok.ok) sim.apply(ok.appends);
    expect(sim.state().jobs.a!.phase).toBe("succeeded");

    // A second complete against the now-terminal job is rejected.
    expect(decideComplete(sim.state(), { jobId: "a", runnerId: "r1", leaseEpoch: 1, outcome: "failed" })).toEqual({ ok: false, reason: "terminal" });
  });

  it("carries a sealed logsDigest onto JobSucceeded only when provided (§4)", () => {
    const withLog = new Sim(linear);
    const c1 = decideClaim(withLog.state(), linear, { jobId: "a", runnerId: "r1" }, T0);
    if (c1.ok) withLog.apply(c1.appends);
    const sealed = decideComplete(withLog.state(), {
      jobId: "a", runnerId: "r1", leaseEpoch: 1, outcome: "succeeded", resultDigest: "sha256:ra", logsDigest: "sha256:lg",
    });
    expect(sealed.ok && sealed.appends[0]!.payload).toMatchObject({ resultDigest: "sha256:ra", logsDigest: "sha256:lg" });

    // Absent log output → no logsDigest field on the event (back-compat shape).
    const noLog = new Sim(linear);
    const c2 = decideClaim(noLog.state(), linear, { jobId: "a", runnerId: "r1" }, T0);
    if (c2.ok) noLog.apply(c2.appends);
    const bare = decideComplete(noLog.state(), { jobId: "a", runnerId: "r1", leaseEpoch: 1, outcome: "succeeded", resultDigest: "sha256:ra" });
    expect(bare.ok && bare.appends[0]!.payload).not.toHaveProperty("logsDigest");
  });
});

describe("sweepLeases", () => {
  it("re-queues a lapsed lease below max attempts", () => {
    const plan: CoordinationPlan = { jobs: { a: { deps: [] } } };
    const events = [
      ev(1, K.RUN_CREATED, undefined, { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null }),
      ev(2, K.JOB_CLAIMED, "a", { runnerId: "r1", leaseEpoch: 1, leaseExpiresAt: "2026-06-19T00:01:00Z", attempt: 1 }),
    ];
    const intents = sweepLeases(reduce(events, plan), T_LATE, { maxAttempts: 5 });
    expect(intents.map((i) => i.kind)).toEqual([K.LEASE_EXPIRED]);
  });

  it("fails a job that has exhausted its attempts (timed_out)", () => {
    const plan: CoordinationPlan = { jobs: { a: { deps: [] } } };
    const events = [
      ev(1, K.RUN_CREATED, undefined, { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null }),
      ev(2, K.JOB_CLAIMED, "a", { runnerId: "r1", leaseEpoch: 5, leaseExpiresAt: "2026-06-19T00:01:00Z", attempt: 5 }),
    ];
    const intents = sweepLeases(reduce(events, plan), T_LATE, { maxAttempts: 5 });
    expect(intents).toEqual([
      { kind: K.JOB_FAILED, jobId: "a", payload: { runnerId: "r1", leaseEpoch: 5, reason: "timed_out", errorText: "runner heartbeat timeout" } },
    ]);
  });

  it("ignores a healthy (un-lapsed) lease", () => {
    const plan: CoordinationPlan = { jobs: { a: { deps: [] } } };
    const events = [
      ev(1, K.RUN_CREATED, undefined, { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null }),
      ev(2, K.JOB_CLAIMED, "a", { runnerId: "r1", leaseEpoch: 1, leaseExpiresAt: "2026-06-19T00:05:00Z", attempt: 1 }),
    ];
    expect(sweepLeases(reduce(events, plan), T_LATE, { maxAttempts: 5 })).toEqual([]);
  });
});

describe("memoization on claim", () => {
  it("a hermetic job with an existing result is memoized (cached), unblocking downstream", () => {
    const sim = new Sim(linear);
    const d = decideClaim(sim.state(), linear, { jobId: "a", runnerId: "r1", hermetic: true, memoResultDigest: "sha256:cached" }, T0);
    expect(d.ok && d.cached).toBe(true);
    if (d.ok) {
      expect(d.appends).toEqual([{ kind: K.JOB_MEMOIZED, jobId: "a", payload: { resultDigest: "sha256:cached" } }]);
      sim.apply(d.appends);
    }
    expect(sim.state().jobs.a!.phase).toBe("memoized");
    expect(sim.state().frontier).toEqual(["b"]);
  });

  it("a non-hermetic job is claimed for execution even if a result digest is supplied", () => {
    const sim = new Sim(linear);
    const d = decideClaim(sim.state(), linear, { jobId: "a", runnerId: "r1", hermetic: false, memoResultDigest: "sha256:cached" }, T0);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.appends[0]!.kind).toBe(K.JOB_CLAIMED);
  });
});

describe("decideCancel", () => {
  it("cancels an active run and rejects a cancel on a terminal run", () => {
    const sim = new Sim(linear);
    const c = decideCancel(sim.state());
    expect(c.ok).toBe(true);
    if (c.ok) sim.apply(c.appends);
    expect(sim.state().phase).toBe("canceled");
    expect(decideCancel(sim.state())).toEqual({ ok: false, reason: "run_terminal" });
  });
});
