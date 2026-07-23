// IC1 measurement harness — DB round-trips for the Activities feed
// (`GET /v1/organizations/{orgId}/state/runs`) and the project-scoped list.
// The 2026-07-23 audit measured 4.3–4.5s for the org feed: a full 50-row page
// cost 1 (list) + 50 (per-run getRunJobCounts, awaited serially) = 51
// sequential Postgres round-trips on per-request Hyperdrive connections
// (~85ms each ≈ the observed stall). The round-trip COUNT is the
// deterministic regression guard; the logged simulated wall-clock
// (trips × 85ms) documents the user-facing effect.

import { handleListOrgRuns, handleListRuns } from "@state-worker/handlers/runs";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ORG_PUBLIC = `org_${ORG.replace(/-/g, "")}`;
const NOW = new Date("2026-06-14T10:00:00.000Z");
const PAGE = 50; // DEFAULT_PAGE_LIMIT — the audit's full-page shape
const ROUND_TRIP_MS = 85; // 51 trips ≈ 4.3s observed in the audit

function fetcherAllow(): Fetcher {
  return {
    fetch: (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("authorization-context")) {
        return Promise.resolve(
          Response.json({
            data: {
              memberships: [
                { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_PUBLIC } },
              ],
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: { allow: true } }));
    },
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}

function createEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: fetcherAllow(),
    POLICY_WORKER: fetcherAllow(),
    PROJECTS_WORKER: fetcherAllow(),
  } as unknown as Env;
}

function runRow(i: number): Record<string, unknown> {
  const id = `${(i + 10).toString(16).padStart(8, "0")}-3333-4333-8333-333333333333`;
  return {
    id,
    org_id: ORG,
    project_id: PROJECT,
    environment: "production",
    run_ulid: `01J000000000000000000${(i + 1000).toString(36).toUpperCase().padStart(4, "0")}`,
    plan_digest: "sha256:" + "a".repeat(64),
    source: "cli",
    status: "succeeded",
    git_commit: "abc123",
    git_ref: "refs/heads/main",
    git_dirty: false,
    labels: "{}",
    created_by: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    created_by_kind: "user",
    started_at: null,
    finished_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

const COUNTS_ROW = { queued: 0, running: 0, succeeded: 3, failed: 0 };

/** Counting executor: answers the list query with `rows`, counts queries with
 *  per-run rows (batched GROUP BY form) or a single tally row (per-run form). */
function countingExecutor(rows: Record<string, unknown>[]): { executor: SqlExecutor; trips: () => number } {
  let trips = 0;
  const executor: SqlExecutor = {
    execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
      trips += 1;
      let result: T[];
      if (text.includes("COUNT(*) FILTER") && text.includes("GROUP BY")) {
        result = rows.map((r) => ({ run_id: r.id, ...COUNTS_ROW })) as unknown as T[];
      } else if (text.includes("COUNT(*) FILTER")) {
        result = [COUNTS_ROW] as unknown as T[];
      } else if (text.startsWith("SELECT * FROM state.runs")) {
        result = rows as unknown as T[];
      } else {
        result = [] as unknown as T[];
      }
      return Promise.resolve({ rows: result, rowCount: result.length });
    },
  };
  return { executor, trips: () => trips };
}

const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

describe("IC1 — /state/runs round-trip budget", () => {
  it("org-global Activities feed: a full 50-run page costs ≤2 DB round-trips", async () => {
    const rows = Array.from({ length: PAGE }, (_, i) => runRow(i));
    const { executor, trips } = countingExecutor(rows);
    const req = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/state/runs`, { method: "GET" });
    const res = await handleListOrgRuns(req, createEnv(), "req_1", ACTOR, asUuid(ORG), { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { runs: Array<{ jobCounts: { succeeded: number } }> } };
    expect(body.data.runs).toHaveLength(PAGE);
    // Every run still carries its job counts — the projection contract is unchanged.
    expect(body.data.runs.every((r) => r.jobCounts.succeeded === 3)).toBe(true);

    // THE IC1 BUDGET: list + batched counts = 2. Before IC1: 1 + 50 = 51.
    // eslint-disable-next-line no-console -- measurement record for the IC1 PR
    console.log(
      `[IC1 bench] org feed: ${trips()} DB round-trips for a ${PAGE}-run page ` +
        `(simulated serial wall-clock @${ROUND_TRIP_MS}ms/trip: ${trips() * ROUND_TRIP_MS}ms)`,
    );
    expect(trips()).toBeLessThanOrEqual(2);
  });

  it("project-scoped list: a full 50-run page costs ≤2 DB round-trips", async () => {
    const rows = Array.from({ length: PAGE }, (_, i) => runRow(i));
    const { executor, trips } = countingExecutor(rows);
    const req = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/projects/prj_x/state/runs`, { method: "GET" });
    const res = await handleListRuns(req, createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { runs: unknown[] } };
    expect(body.data.runs).toHaveLength(PAGE);
    // eslint-disable-next-line no-console -- measurement record for the IC1 PR
    console.log(
      `[IC1 bench] project list: ${trips()} DB round-trips for a ${PAGE}-run page ` +
        `(simulated serial wall-clock @${ROUND_TRIP_MS}ms/trip: ${trips() * ROUND_TRIP_MS}ms)`,
    );
    expect(trips()).toBeLessThanOrEqual(2);
  });
});
