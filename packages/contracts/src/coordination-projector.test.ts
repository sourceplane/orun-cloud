import { describe, expect, it } from "vitest";

import type { JobPhase } from "./coordination.js";
import { COORDINATION_FOLD_VECTORS } from "./coordination-vectors.js";
import { planProjection } from "./coordination-projector.js";
import type { RunJobStatus } from "./state.js";

function vector(nameStart: string) {
  const v = COORDINATION_FOLD_VECTORS.find((x) => x.name.startsWith(nameStart));
  if (!v) throw new Error(`no vector starting with ${nameStart}`);
  return v;
}

const EXPECTED_JOB_STATUS: Record<JobPhase, RunJobStatus> = {
  queued: "queued",
  claimed: "claimed",
  succeeded: "succeeded",
  memoized: "succeeded",
  failed: "failed",
  timed_out: "timed_out",
  canceled: "canceled",
};

describe("planProjection — mapping to the read model", () => {
  for (const v of COORDINATION_FOLD_VECTORS) {
    it(v.name, () => {
      // Apply against one-below the fold's seq so every vector (including the
      // zero-seq empty fold) exercises the mapping rather than the idempotent gate.
      const plan = planProjection(v.expected, v.expected.lastSeq - 1);
      expect(plan.apply).toBe(true);
      expect(plan.toSeq).toBe(v.expected.lastSeq);

      // run status is the fold phase verbatim (RunPhase ≡ RunStatus)
      expect(plan.run?.status).toBe(v.expected.phase);
      expect(plan.run?.lastSeq).toBe(v.expected.lastSeq);
      expect(plan.run?.planDigest).toBe(v.expected.planDigest);

      // one job row per fold job, in jobId order, each phase mapped
      const ids = Object.keys(v.expected.jobs).sort();
      expect(plan.jobs?.map((j) => j.jobId)).toEqual(ids);
      for (const row of plan.jobs ?? []) {
        const foldPhase = v.expected.jobs[row.jobId]!.phase;
        expect(row.status).toBe(EXPECTED_JOB_STATUS[foldPhase]);
      }
    });
  }
});

describe("planProjection — memoized collapses to succeeded", () => {
  it("a memoized job is written as succeeded with its result digest", () => {
    const v = vector("memoized job");
    const plan = planProjection(v.expected, 0);
    const memoJob = Object.entries(v.expected.jobs).find(([, j]) => j.phase === "memoized");
    expect(memoJob).toBeDefined();
    const [jobId] = memoJob!;
    const row = plan.jobs?.find((j) => j.jobId === jobId);
    expect(row?.status).toBe("succeeded");
    expect(row?.resultDigest).toBe(v.expected.jobs[jobId]!.resultDigest);
  });
});

describe("planProjection — idempotency gate", () => {
  it("a fold no newer than the applied seq is a no-op", () => {
    const v = vector("diamond");
    const plan = planProjection(v.expected, v.expected.lastSeq);
    expect(plan.apply).toBe(false);
    expect(plan.toSeq).toBe(v.expected.lastSeq);
    expect(plan.run).toBeUndefined();
    expect(plan.jobs).toBeUndefined();
  });

  it("a fold one seq newer is applied", () => {
    const v = vector("diamond");
    const plan = planProjection(v.expected, v.expected.lastSeq - 1);
    expect(plan.apply).toBe(true);
    expect(plan.toSeq).toBe(v.expected.lastSeq);
  });

  it("a strictly-older applied seq still applies (monotonic advance)", () => {
    const v = vector("diamond");
    expect(planProjection(v.expected, 0).apply).toBe(true);
  });
});

describe("planProjection — run-level statuses pass through", () => {
  it("a canceled run projects status canceled", () => {
    const v = vector("cancel");
    expect(planProjection(v.expected, 0).run?.status).toBe("canceled");
  });

  it("counts ride along on the run row", () => {
    const v = vector("diamond");
    expect(planProjection(v.expected, 0).run?.jobCounts).toEqual({
      queued: 0, running: 0, succeeded: 4, failed: 0,
    });
  });
});
