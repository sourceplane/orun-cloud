import type { SqlExecutor } from "@saas/db/hyperdrive";
import { beforeEach, describe, expect, it } from "vitest";

import { __resetProjectorReadyCache, projectorReady } from "../src/coordination-route.js";

/** A probe executor that either resolves (column present) or throws (absent). */
function probe(missing: boolean): { executor: SqlExecutor; calls: () => number } {
  let calls = 0;
  const executor = {
    async execute() {
      calls += 1;
      if (missing) throw new Error('column "last_seq" does not exist');
      return { rows: [], rowCount: 0 };
    },
  } as unknown as SqlExecutor;
  return { executor, calls: () => calls };
}

describe("projectorReady (fail-closed cutover gate)", () => {
  beforeEach(() => __resetProjectorReadyCache());

  it("fails closed when state.runs.last_seq is missing (migration 350 not applied)", async () => {
    const p = probe(true);
    expect(await projectorReady(p.executor)).toBe(false);
  });

  it("does not cache a negative result — self-heals once the migration lands", async () => {
    const failing = probe(true);
    expect(await projectorReady(failing.executor)).toBe(false);
    const ok = probe(false);
    expect(await projectorReady(ok.executor)).toBe(true);
  });

  it("caches the positive result so it probes at most once per isolate", async () => {
    const p = probe(false);
    expect(await projectorReady(p.executor)).toBe(true);
    expect(await projectorReady(p.executor)).toBe(true);
    expect(p.calls()).toBe(1);
  });
});
