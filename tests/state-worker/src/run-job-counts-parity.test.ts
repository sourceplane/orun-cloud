// IC1 parity guard (risks doc: "the grouped-counts rewrite must match
// getRunJobCounts semantics per run (including zero-count runs)"). Drives the
// real repository SQL against an in-memory state.run_jobs store that
// interprets both the per-run tally and the grouped jsonb_to_recordset batch,
// then asserts the batch answer equals the per-run loop answer for every run.

import { createStateRepository } from "@saas/db/state";
import type { RunJobCounts } from "@saas/db/state";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT_A = "44444444-4444-4444-8444-444444444444";
const PROJECT_B = "55555555-5555-4555-8555-555555555555";
const RUN_1 = "aaaaaaaa-1111-4111-8111-111111111111"; // project A, mixed statuses
const RUN_2 = "bbbbbbbb-2222-4222-8222-222222222222"; // project B, all succeeded
const RUN_3 = "cccccccc-3333-4333-8333-333333333333"; // project A, ZERO jobs

interface JobRow {
  org_id: string;
  project_id: string;
  run_id: string;
  status: string;
}

const JOBS: JobRow[] = [
  { org_id: ORG, project_id: PROJECT_A, run_id: RUN_1, status: "queued" },
  { org_id: ORG, project_id: PROJECT_A, run_id: RUN_1, status: "claimed" },
  { org_id: ORG, project_id: PROJECT_A, run_id: RUN_1, status: "running" },
  { org_id: ORG, project_id: PROJECT_A, run_id: RUN_1, status: "succeeded" },
  { org_id: ORG, project_id: PROJECT_A, run_id: RUN_1, status: "failed" },
  { org_id: ORG, project_id: PROJECT_A, run_id: RUN_1, status: "timed_out" },
  { org_id: ORG, project_id: PROJECT_B, run_id: RUN_2, status: "succeeded" },
  { org_id: ORG, project_id: PROJECT_B, run_id: RUN_2, status: "succeeded" },
  // A row whose run_id matches RUN_2 but under the WRONG project — the exact
  // (project, run) pair match must exclude it, like the per-run query does.
  { org_id: ORG, project_id: PROJECT_A, run_id: RUN_2, status: "failed" },
];

function tally(rows: JobRow[]): Record<string, unknown> {
  return {
    queued: rows.filter((r) => r.status === "queued").length,
    running: rows.filter((r) => r.status === "claimed" || r.status === "running").length,
    succeeded: rows.filter((r) => r.status === "succeeded").length,
    failed: rows.filter((r) => r.status === "failed" || r.status === "timed_out").length,
  };
}

/** Interprets the two real queries the repository issues against JOBS. */
function jobsExecutor(): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<SqlExecutorResult<T>> {
      if (text.includes("jsonb_to_recordset") && text.includes("GROUP BY j.run_id")) {
        const orgId = String(params[0]);
        const pairs = JSON.parse(String(params[1])) as Array<{ project_id: string; run_id: string }>;
        const out: Record<string, unknown>[] = [];
        for (const pair of pairs) {
          const rows = JOBS.filter(
            (j) => j.org_id === orgId && j.project_id === pair.project_id && j.run_id === pair.run_id,
          );
          if (rows.length > 0) out.push({ run_id: pair.run_id, ...tally(rows) });
        }
        return Promise.resolve({ rows: out as unknown as T[], rowCount: out.length });
      }
      if (text.includes("COUNT(*) FILTER")) {
        const [orgId, projectId, runId] = params.map(String);
        const rows = JOBS.filter((j) => j.org_id === orgId && j.project_id === projectId && j.run_id === runId);
        return Promise.resolve({ rows: [tally(rows)] as unknown as T[], rowCount: 1 });
      }
      return Promise.resolve({ rows: [] as unknown as T[], rowCount: 0 });
    },
  };
}

describe("IC1 — getRunJobCountsBatch parity with the per-run loop", () => {
  const refs = [
    { projectId: asUuid(PROJECT_A), runId: asUuid(RUN_1) },
    { projectId: asUuid(PROJECT_B), runId: asUuid(RUN_2) },
    { projectId: asUuid(PROJECT_A), runId: asUuid(RUN_3) },
  ];

  it("matches getRunJobCounts for every run, absent-key = zero counts", async () => {
    const repo = createStateRepository(jobsExecutor());
    const batch = await repo.getRunJobCountsBatch(asUuid(ORG), refs);
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;

    const zero: RunJobCounts = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    for (const ref of refs) {
      const single = await repo.getRunJobCounts(asUuid(ORG), ref.projectId, ref.runId);
      expect(single.ok).toBe(true);
      if (!single.ok) continue;
      const fromBatch = batch.value.get(ref.runId) ?? zero;
      expect(fromBatch).toEqual(single.value);
    }
    // The zero-job run is absent from the batch map (callers substitute zeros).
    expect(batch.value.has(RUN_3)).toBe(false);
    // The wrong-project row for RUN_2 was excluded by the exact pair match.
    expect(batch.value.get(RUN_2)).toEqual({ queued: 0, running: 0, succeeded: 2, failed: 0 });
  });

  it("returns an empty map for an empty page without touching the DB", async () => {
    let executed = 0;
    const executor: SqlExecutor = {
      execute<T extends SqlRow = SqlRow>(): Promise<SqlExecutorResult<T>> {
        executed += 1;
        return Promise.resolve({ rows: [] as unknown as T[], rowCount: 0 });
      },
    };
    const repo = createStateRepository(executor);
    const batch = await repo.getRunJobCountsBatch(asUuid(ORG), []);
    expect(batch.ok).toBe(true);
    if (batch.ok) expect(batch.value.size).toBe(0);
    expect(executed).toBe(0);
  });
});
