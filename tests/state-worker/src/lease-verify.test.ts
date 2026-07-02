// verifyLiveLease (saas-secret-manager SM3) — the second, independent gate of
// the secret resolve. Covers BOTH coordination backends (Q-10).

import { verifyLiveLease } from "@state-worker/lease";
import type { Env } from "@state-worker/env";
import type { RunFoldState } from "@saas/contracts/coordination";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = asUuid("11111111-1111-4111-8111-111111111111");
const PRJ = asUuid("22222222-2222-4222-8222-222222222222");
const RUN = "01J0000000000000000000ABCD";
const NOW = new Date("2026-07-02T00:00:00.000Z");
const FUTURE = "2026-07-02T00:01:00.000Z";
const PAST = "2026-07-01T00:00:00.000Z";

function args(over: Partial<Parameters<typeof verifyLiveLease>[1]> = {}) {
  return { orgId: ORG, projectId: PRJ, runUlid: RUN, jobId: "deploy", runnerId: "host-a", leaseEpoch: 3, ...over };
}

function relExecutor(row: Record<string, unknown> | null): SqlExecutor {
  return {
    async execute<T extends SqlRow = SqlRow>(): Promise<SqlExecutorResult<T>> {
      return { rows: (row ? [row] : []) as unknown as T[], rowCount: row ? 1 : 0 };
    },
  };
}

function fold(over: Partial<RunFoldState["jobs"]["deploy"]> = {}): RunFoldState {
  return {
    runId: RUN,
    planDigest: null,
    sourceHash: null,
    phase: "running",
    frontier: [],
    lastSeq: 1,
    jobs: {
      deploy: { jobId: "deploy", phase: "claimed", holder: "host-a", leaseEpoch: 3, leaseExpiresAt: FUTURE, ...over },
    },
  } as RunFoldState;
}

const EMPTY_ENV = {} as Env;
const DO_ENV = { COORDINATOR: {} } as unknown as Env;

describe("relational backend", () => {
  it("is live for the holder with an unexpired lease", async () => {
    const res = await verifyLiveLease(EMPTY_ENV, args(), {
      executor: relExecutor({ status: "claimed", runner_id: "host-a", live: true }),
      now: () => NOW,
    });
    expect(res).toEqual({ live: true });
  });

  it("is lease_lost for a foreign runner / lapsed lease (row present, live=false)", async () => {
    const res = await verifyLiveLease(EMPTY_ENV, args({ runnerId: "host-b" }), {
      executor: relExecutor({ status: "claimed", runner_id: "host-a", live: false }),
      now: () => NOW,
    });
    expect(res).toEqual({ live: false, reason: "lease_lost" });
  });

  it("is not_found when there is no such job row", async () => {
    const res = await verifyLiveLease(EMPTY_ENV, args(), { executor: relExecutor(null), now: () => NOW });
    expect(res).toEqual({ live: false, reason: "not_found" });
  });
});

describe("DO backend", () => {
  it("is live when the fold job is claimed by this runner at this epoch, unexpired", async () => {
    const res = await verifyLiveLease(DO_ENV, args(), { readState: async () => fold(), now: () => NOW });
    expect(res).toEqual({ live: true });
  });

  it("is lease_lost on a stale epoch", async () => {
    const res = await verifyLiveLease(DO_ENV, args({ leaseEpoch: 2 }), { readState: async () => fold({ leaseEpoch: 3 }), now: () => NOW });
    expect(res).toEqual({ live: false, reason: "lease_lost" });
  });

  it("is lease_lost when the lease has expired", async () => {
    const res = await verifyLiveLease(DO_ENV, args(), { readState: async () => fold({ leaseExpiresAt: PAST }), now: () => NOW });
    expect(res).toEqual({ live: false, reason: "lease_lost" });
  });

  it("is lease_lost for a foreign holder", async () => {
    const res = await verifyLiveLease(DO_ENV, args(), { readState: async () => fold({ holder: "host-b" }), now: () => NOW });
    expect(res).toEqual({ live: false, reason: "lease_lost" });
  });

  it("is not_found when the job is absent from the fold", async () => {
    const empty = fold();
    delete (empty.jobs as Record<string, unknown>).deploy;
    const res = await verifyLiveLease(DO_ENV, args(), { readState: async () => empty, now: () => NOW });
    expect(res).toEqual({ live: false, reason: "not_found" });
  });
});
