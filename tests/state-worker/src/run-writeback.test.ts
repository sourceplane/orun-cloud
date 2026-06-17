// OV5/IG9 outbound bridge — the run-result → GitHub write-back driver. Verifies
// the drain reads terminal run events, resolves each run's commit + the
// project's active GitHub link, posts a Check Run (with the right conclusion)
// through the injected poster, advances the cursor PER EVENT (at-most-once), and
// skips (never fails) gitless runs / unlinked projects. DB is a scripted
// executor; the poster is a spy (no service binding, no network).

import { drainRunWriteback, type WritebackPoster } from "@state-worker/run-writeback";
import type { WritebackRequest, WritebackResponse } from "@saas/contracts/integrations";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const TS = "2026-06-17T10:00:00.000Z";

interface ScenarioOpts {
  /** Project resolves to an active github link with this repo id (null = unlinked). */
  providerRepoId?: string | null;
  /** Run's git commit (null = gitless run). */
  gitCommit?: string | null;
  environment?: string | null;
}

function runResultEventRow(over: { id: string; type: string; occurred_at?: string; runUlid: string }): Record<string, unknown> {
  return {
    id: over.id,
    type: over.type,
    version: 1,
    source: "state-worker",
    occurred_at: over.occurred_at ?? TS,
    actor_type: "system",
    actor_id: "system:state-sweep",
    org_id: ORG,
    project_id: PROJECT,
    subject_kind: "run",
    subject_id: "run-row-1",
    subject_name: over.runUlid,
    request_id: "req",
    created_at: TS,
    redact_paths: "[]",
    payload: JSON.stringify({ version: 1, runId: over.runUlid, status: over.type.endsWith("failed") ? "failed" : "succeeded" }),
  };
}

function scenarioExecutor(
  events: Record<string, unknown>[],
  opts: ScenarioOpts = {},
): { executor: SqlExecutor; cursor: Record<string, unknown>; advances: number } {
  const cursor: Record<string, unknown> = {};
  let advances = 0;
  const providerRepoId = opts.providerRepoId === undefined ? "777001" : opts.providerRepoId;
  const gitCommit = opts.gitCommit === undefined ? "abc123def" : opts.gitCommit;

  function run(text: string): Record<string, unknown>[] {
    if (text.includes("FROM state.run_writeback_cursor")) {
      return cursor.last_event_id ? [cursor] : [];
    }
    if (text.includes("FROM events.event_log")) {
      return events;
    }
    if (text.includes("FROM state.runs")) {
      return [
        {
          id: "run-row-1",
          org_id: ORG,
          project_id: PROJECT,
          environment: opts.environment ?? "production",
          run_ulid: "run_01",
          plan_digest: "sha256:p",
          source: "ci",
          status: "succeeded",
          git_commit: gitCommit,
          git_ref: "refs/heads/main",
          git_dirty: false,
          labels: "{}",
          created_at: TS,
          updated_at: TS,
        },
      ];
    }
    if (text.includes("FROM state.workspace_links")) {
      if (!providerRepoId) return [];
      return [
        {
          id: "link-1",
          org_id: ORG,
          project_id: PROJECT,
          remote_url: "github.com/acme/storefront",
          status: "active",
          provider: "github",
          provider_repo_id: providerRepoId,
          created_at: TS,
          updated_at: TS,
        },
      ];
    }
    if (text.includes("INSERT INTO state.run_writeback_cursor")) {
      advances++;
      return [];
    }
    return [];
  }

  const executor: SqlExecutor = {
    execute<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<SqlExecutorResult<T>> {
      if (text.includes("INSERT INTO state.run_writeback_cursor")) {
        cursor.last_occurred_at = params[0];
        cursor.last_event_id = params[1];
      }
      const rows = run(text) as unknown as T[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as SqlExecutor;

  return { executor, cursor, advances };
}

function spyPoster(response: WritebackResponse | null): { post: WritebackPoster; calls: WritebackRequest[] } {
  const calls: WritebackRequest[] = [];
  return {
    post: (body) => {
      calls.push(body);
      return Promise.resolve(response);
    },
    calls,
  };
}

const COMPLETED = runResultEventRow({ id: "evt_run_ok", type: "state.run.completed", runUlid: "run_01" });
const FAILED = runResultEventRow({ id: "evt_run_bad", type: "state.run.failed", occurred_at: "2026-06-17T11:00:00.000Z", runUlid: "run_02" });

describe("drainRunWriteback (OV5/IG9 outbound)", () => {
  it("posts a success Check Run for a completed run on a linked repo, and advances the cursor", async () => {
    const { executor, cursor } = scenarioExecutor([COMPLETED]);
    const { post, calls } = spyPoster({ outcome: "posted", resource: { id: 555, url: null } });

    const summary = await drainRunWriteback(executor, post);

    expect(summary).toEqual({ scanned: 1, posted: 1, skipped: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    const body = calls[0]!;
    expect(body.kind).toBe("check_run");
    expect(body.repoExternalId).toBe("777001");
    expect(body.orgId).toMatch(/^org_/); // public id, not the uuid
    if (body.kind === "check_run") {
      expect(body.checkRun.headSha).toBe("abc123def");
      expect(body.checkRun.status).toBe("completed");
      expect(body.checkRun.conclusion).toBe("success");
      expect(body.checkRun.summary).toContain("production");
    }
    // Cursor advanced to the (only) event.
    expect(cursor.last_event_id).toBe("evt_run_ok");
    expect(cursor.last_occurred_at).toBe(TS);
  });

  it("maps a failed run to a failure conclusion", async () => {
    const { executor } = scenarioExecutor([FAILED]);
    const { post, calls } = spyPoster({ outcome: "posted", resource: { id: 9, url: null } });
    const summary = await drainRunWriteback(executor, post);
    expect(summary.posted).toBe(1);
    if (calls[0]!.kind === "check_run") expect(calls[0]!.checkRun.conclusion).toBe("failure");
  });

  it("skips (no post) a gitless run — nothing to attach a Check Run to", async () => {
    const { executor, cursor } = scenarioExecutor([COMPLETED], { gitCommit: null });
    const { post, calls } = spyPoster({ outcome: "posted", resource: { id: 1, url: null } });
    const summary = await drainRunWriteback(executor, post);
    expect(summary).toEqual({ scanned: 1, posted: 0, skipped: 1, failed: 0 });
    expect(calls).toHaveLength(0);
    // Still advances the cursor so the event never re-drains.
    expect(cursor.last_event_id).toBe("evt_run_ok");
  });

  it("skips a run whose project has no active GitHub link", async () => {
    const { executor } = scenarioExecutor([COMPLETED], { providerRepoId: null });
    const { post, calls } = spyPoster({ outcome: "posted", resource: { id: 1, url: null } });
    const summary = await drainRunWriteback(executor, post);
    expect(summary.skipped).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("counts a downstream skip/failed outcome without throwing", async () => {
    const { executor } = scenarioExecutor([COMPLETED]);
    const failing = spyPoster({ outcome: "failed", reason: "github_rejected" });
    expect((await drainRunWriteback(executor, failing.post)).failed).toBe(1);

    const { executor: ex2 } = scenarioExecutor([COMPLETED]);
    const skipped = spyPoster({ outcome: "skipped", reason: "repo_not_app_linked" });
    expect((await drainRunWriteback(ex2, skipped.post)).skipped).toBe(1);

    const { executor: ex3 } = scenarioExecutor([COMPLETED]);
    const nulled = spyPoster(null); // the binding call itself failed
    expect((await drainRunWriteback(ex3, nulled.post)).failed).toBe(1);
  });

  it("advances the cursor once per event across a batch", async () => {
    const { executor, cursor } = scenarioExecutor([COMPLETED, FAILED]);
    const { post } = spyPoster({ outcome: "posted", resource: { id: 1, url: null } });
    const summary = await drainRunWriteback(executor, post);
    expect(summary.scanned).toBe(2);
    expect(summary.posted).toBe(2);
    // Cursor ends on the last (newest) event.
    expect(cursor.last_event_id).toBe("evt_run_bad");
    expect(cursor.last_occurred_at).toBe("2026-06-17T11:00:00.000Z");
  });

  it("does nothing when there are no new run events", async () => {
    const { executor } = scenarioExecutor([]);
    const { post, calls } = spyPoster({ outcome: "posted", resource: { id: 1, url: null } });
    const summary = await drainRunWriteback(executor, post);
    expect(summary).toEqual({ scanned: 0, posted: 0, skipped: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });
});
