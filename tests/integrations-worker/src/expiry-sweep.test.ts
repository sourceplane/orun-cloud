// IH9 — minted-credential expiry sweep. Verifies the single bounded bulk
// UPDATE ("TTL is the backstop", design §5.1): past-due pending ledger rows
// flip to expired, the cutoff/limit ride the params, and a repo failure never
// throws out of the cron phase.

import { runExpirySweep, EXPIRY_SWEEP_LIMIT } from "@integrations-worker/expiry-sweep";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const NOW = new Date("2026-07-12T04:00:00Z");

type QueryRecord = { text: string; params: unknown[] };
type SqlResponder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: SqlResponder): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

describe("runExpirySweep", () => {
  it("flips past-due pending mints in one bulk statement and reports the count", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("UPDATE integrations.minted_credentials")) {
        return [{ id: "m1" }, { id: "m2" }, { id: "m3" }];
      }
      return [];
    });

    const summary = await runExpirySweep(executor, { now: NOW });

    expect(summary).toEqual({ expired: 3 });
    expect(queries).toHaveLength(1);
    const update = queries[0]!;
    expect(update.text).toContain("UPDATE integrations.minted_credentials");
    expect(update.text).toContain("revoke_status = 'pending'");
    // The cutoff and batch bound ride the params: [now, limit].
    expect(update.params).toEqual([NOW, EXPIRY_SWEEP_LIMIT]);
  });

  it("passes a custom limit through", async () => {
    const { executor, queries } = fakeExecutor(() => []);
    const summary = await runExpirySweep(executor, { now: NOW, limit: 7 });
    expect(summary).toEqual({ expired: 0 });
    expect(queries[0]!.params).toEqual([NOW, 7]);
  });

  it("never throws on a repo failure — reports zero and lets the cron continue", async () => {
    const executor: SqlExecutor = {
      async execute<T extends SqlRow = SqlRow>(): Promise<SqlExecutorResult<T>> {
        throw new Error("db down");
      },
    };
    await expect(runExpirySweep(executor, { now: NOW })).resolves.toEqual({ expired: 0 });
  });
});
