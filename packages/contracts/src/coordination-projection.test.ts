import { describe, expect, it } from "vitest";

import { COORDINATION_FOLD_VECTORS } from "./coordination-vectors.js";
import { projectRun } from "./coordination-projection.js";

function vector(nameStart: string) {
  const v = COORDINATION_FOLD_VECTORS.find((x) => x.name.startsWith(nameStart));
  if (!v) throw new Error(`no vector starting with ${nameStart}`);
  return v;
}

describe("projectRun — consistency with the fold", () => {
  for (const v of COORDINATION_FOLD_VECTORS) {
    it(v.name, () => {
      const { run, jobs } = projectRun(v.expected);
      // run summary mirrors the fold
      expect(run.phase).toBe(v.expected.phase);
      expect(run.lastSeq).toBe(v.expected.lastSeq);
      expect(run.runId).toBe(v.expected.runId);
      expect(run.planDigest).toBe(v.expected.planDigest);
      // one row per job, sorted, counts partition the jobs exactly
      const ids = Object.keys(v.expected.jobs);
      expect(jobs.map((j) => j.jobId)).toEqual([...ids].sort());
      const sum = run.jobCounts.queued + run.jobCounts.running + run.jobCounts.succeeded + run.jobCounts.failed;
      expect(sum).toBe(ids.length);
    });
  }
});

describe("projectRun — counts buckets", () => {
  it("diamond completion → all succeeded", () => {
    expect(projectRun(vector("diamond").expected).run.jobCounts).toEqual({
      queued: 0, running: 0, succeeded: 4, failed: 0,
    });
  });

  it("created + claim a → one running, one queued", () => {
    expect(projectRun(vector("created + claim").expected).run.jobCounts).toEqual({
      queued: 1, running: 1, succeeded: 0, failed: 0,
    });
  });

  it("failed dependency → one failed, downstream still queued", () => {
    expect(projectRun(vector("failed dependency").expected).run.jobCounts).toEqual({
      queued: 1, running: 0, succeeded: 0, failed: 1,
    });
  });

  it("memoized → counts as succeeded, downstream queued", () => {
    expect(projectRun(vector("memoized job").expected).run.jobCounts).toEqual({
      queued: 1, running: 0, succeeded: 1, failed: 0,
    });
  });

  it("cancel → non-terminal jobs bucket as failed", () => {
    expect(projectRun(vector("cancel marks").expected).run.jobCounts).toEqual({
      queued: 0, running: 0, succeeded: 0, failed: 2,
    });
  });
});

describe("projectRun — job rows carry the fold fields", () => {
  it("emits holder/attempt/leaseExpiresAt for a claimed job", () => {
    const { jobs } = projectRun(vector("created + claim").expected);
    const a = jobs.find((j) => j.jobId === "a")!;
    expect(a.phase).toBe("claimed");
    expect(a.holder).toBe("runner-1");
    expect(a.attempt).toBe(1);
    expect(a.leaseExpiresAt).not.toBeNull();
  });
});
