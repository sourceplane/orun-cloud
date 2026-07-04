// Catalog-projection reliability sweep. The sweep drives from the pending drive
// set (state.catalog_heads LEFT JOIN state.catalog_projection) and re-projects each
// lagging scope. Here we inject a fake executor that returns the drive set and
// assert the sweep scans + iterates it; the projection itself (and its outbox
// recording) is covered in catalog-projection.test.ts. Under a bare Env (no R2),
// projectCatalogSnapshot returns null without throwing, so the loop still runs.

import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import type { Env } from "@state-worker/env";
import { runCatalogProjectionSweep } from "@state-worker/catalog-projection-sweep";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";

function driveSetExecutor(rows: Array<Record<string, unknown>>): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
      if (text.includes("LEFT JOIN state.catalog_projection")) {
        return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
      }
      return Promise.resolve({ rows: [] as unknown as T[], rowCount: 0 });
    },
  } as unknown as SqlExecutor;
}

describe("runCatalogProjectionSweep", () => {
  it("scans and re-projects each scope whose read model lags its head", async () => {
    const executor = driveSetExecutor([
      { org_id: ORG, project_id: PROJECT, environment: null, digest: "sha256:" + "a".repeat(64), commit: "c1" },
    ]);
    const summary = await runCatalogProjectionSweep({} as Env, { executor });
    expect(summary).toEqual({ scanned: 1, projected: 1 });
  });

  it("no-ops cleanly when nothing is pending", async () => {
    const summary = await runCatalogProjectionSweep({} as Env, { executor: driveSetExecutor([]) });
    expect(summary).toEqual({ scanned: 0, projected: 0 });
  });

  it("is a dormant no-op when Postgres is unbound", async () => {
    const summary = await runCatalogProjectionSweep({} as Env, {});
    expect(summary).toBeNull();
  });
});
