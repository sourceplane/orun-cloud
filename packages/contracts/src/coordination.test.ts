import { describe, expect, it } from "vitest";

import {
  COORDINATION_EVENT_TYPES as K,
  reduce,
  type CoordinationActor,
  type CoordinationEvent,
  type CoordinationPlan,
} from "./coordination.js";
import { COORDINATION_FOLD_VECTORS } from "./coordination-vectors.js";

const A: CoordinationActor = { id: "u1", type: "user" };
const AT = "2026-06-19T00:00:00Z";
const LE = "2026-06-19T00:01:00Z";

describe("coordination reduce() — golden vectors (cross-language contract)", () => {
  for (const v of COORDINATION_FOLD_VECTORS) {
    it(v.name, () => {
      expect(reduce(v.events, v.plan)).toEqual(v.expected);
    });
  }
});

describe("coordination reduce() — properties", () => {
  it("is deterministic for identical input", () => {
    const v = COORDINATION_FOLD_VECTORS.find((x) => x.name.startsWith("diamond"))!;
    expect(reduce(v.events, v.plan)).toEqual(reduce(v.events, v.plan));
  });

  it("keeps terminal job states sticky (a late success cannot revive a failure)", () => {
    const plan: CoordinationPlan = { jobs: { a: { deps: [] } } };
    const events: CoordinationEvent[] = [
      { seq: 1, kind: K.RUN_CREATED, runId: "r", actor: A, at: AT, idempotencyKey: "r", v: 1,
        payload: { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null } },
      { seq: 2, kind: K.JOB_CLAIMED, runId: "r", jobId: "a", actor: A, at: AT, idempotencyKey: "a:c:1", v: 1,
        payload: { runnerId: "r1", leaseEpoch: 1, leaseExpiresAt: LE, attempt: 1 } },
      { seq: 3, kind: K.JOB_FAILED, runId: "r", jobId: "a", actor: A, at: AT, idempotencyKey: "a:f:1", v: 1,
        payload: { runnerId: "r1", leaseEpoch: 1, reason: "step_failed", errorText: "boom" } },
      { seq: 4, kind: K.JOB_SUCCEEDED, runId: "r", jobId: "a", actor: A, at: AT, idempotencyKey: "a:s:1", v: 1,
        payload: { runnerId: "r1", leaseEpoch: 1, resultDigest: "sha256:late" } },
    ];
    const s = reduce(events, plan);
    expect(s.jobs.a!.phase).toBe("failed");
    expect(s.jobs.a!.resultDigest).toBeNull();
    expect(s.phase).toBe("failed");
  });

  it("is idempotent under a duplicated append (same seq applied twice)", () => {
    const plan: CoordinationPlan = { jobs: { a: { deps: [] } } };
    const claim: CoordinationEvent = {
      seq: 2, kind: K.JOB_CLAIMED, runId: "r", jobId: "a", actor: A, at: AT, idempotencyKey: "a:c:1", v: 1,
      payload: { runnerId: "r1", leaseEpoch: 1, leaseExpiresAt: LE, attempt: 1 },
    };
    const created: CoordinationEvent = {
      seq: 1, kind: K.RUN_CREATED, runId: "r", actor: A, at: AT, idempotencyKey: "r", v: 1,
      payload: { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null },
    };
    const once = reduce([created, claim], plan);
    const twice = reduce([created, claim, claim], plan);
    expect(twice).toEqual(once);
  });

  it("ignores events for jobs absent from the plan", () => {
    const plan: CoordinationPlan = { jobs: { a: { deps: [] } } };
    const ghost: CoordinationEvent = {
      seq: 1, kind: K.JOB_CLAIMED, runId: "r", jobId: "ghost", actor: A, at: AT, idempotencyKey: "ghost:c:1", v: 1,
      payload: { runnerId: "r1", leaseEpoch: 1, leaseExpiresAt: LE, attempt: 1 },
    };
    const s = reduce([ghost], plan);
    expect(Object.keys(s.jobs)).toEqual(["a"]);
    expect(s.frontier).toEqual(["a"]);
  });
});
