import { COORDINATION_EVENT_TYPES as K, reduce, type CoordinationEvent } from "@saas/contracts/coordination";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import { runProjectionSweep } from "../src/projection-sweep.js";

function ev(seq: number, kind: string, jobId: string | undefined, payload: unknown): CoordinationEvent {
  return { seq, kind, runId: "r1", jobId, actor: { id: "u", type: "user" }, at: "t", idempotencyKey: `${seq}`, v: 1, payload } as CoordinationEvent;
}

const FOLD = reduce(
  [
    ev(1, K.RUN_CREATED, undefined, { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null }),
    ev(2, K.JOB_CLAIMED, "a", { runnerId: "r1", leaseEpoch: 1, leaseExpiresAt: "2026-12-01T00:00:00Z", attempt: 1 }),
  ],
  { jobs: { a: { deps: [] }, b: { deps: ["a"] } } },
);

function doEnv(backend: string | undefined): Env {
  const stub = { fetch: async () => new Response(JSON.stringify(FOLD), { status: 200 }) };
  const ns = { idFromName: (n: string) => ({ name: n }), get: () => stub };
  return { COORDINATION_BACKEND: backend, COORDINATOR: ns, PLATFORM_DB: {} } as unknown as Env;
}

function fakeExecutor(runRows: { org_id: string; project_id: string; run_ulid: string }[]): {
  exec: SqlExecutor;
  updates: number;
} {
  let updates = 0;
  const exec: SqlExecutor = {
    async execute(text) {
      if (/FROM state\.runs\s+WHERE status IN/.test(text)) return { rows: runRows as never[], rowCount: runRows.length };
      if (/SELECT last_seq/.test(text)) return { rows: [{ last_seq: 0 }] as never[], rowCount: 1 };
      if (/UPDATE state\.runs/.test(text)) {
        updates += 1;
        return { rows: [{ id: "row" }] as never[], rowCount: 1 };
      }
      return { rows: [] as never[], rowCount: 0 };
    },
  };
  return { exec, get updates() { return updates; } } as { exec: SqlExecutor; updates: number };
}

describe("runProjectionSweep", () => {
  it("projects each non-terminal run from its shard", async () => {
    const { exec } = fakeExecutor([
      { org_id: "o", project_id: "p", run_ulid: "r1" },
      { org_id: "o", project_id: "p", run_ulid: "r2" },
    ]);
    const summary = await runProjectionSweep(doEnv("do"), { executor: exec });
    expect(summary).toEqual({ scanned: 2, projected: 2 });
  });

  it("is dormant unless COORDINATION_BACKEND=do", async () => {
    const { exec } = fakeExecutor([{ org_id: "o", project_id: "p", run_ulid: "r1" }]);
    expect(await runProjectionSweep(doEnv(undefined), { executor: exec })).toBeNull();
    expect(await runProjectionSweep(doEnv("op2"), { executor: exec })).toBeNull();
  });

  it("returns a zero summary when there are no non-terminal runs", async () => {
    const { exec } = fakeExecutor([]);
    expect(await runProjectionSweep(doEnv("do"), { executor: exec })).toEqual({ scanned: 0, projected: 0 });
  });
});
