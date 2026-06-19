import { PGlite } from "@electric-sql/pglite";
import { COORDINATION_EVENT_TYPES as K, reduce, type CoordinationEvent } from "@saas/contracts/coordination";
import { planProjection } from "@saas/contracts/coordination-projector";
import { beforeEach, describe, expect, it } from "vitest";

import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";
import { applyProjection } from "./projector.js";

// Integration test for the projector apply against a real Postgres engine
// (pglite, in-process WASM) using a schema faithful to migration 220 + the 350
// last_seq column. Verifies the seq-guarded UPSERT and its idempotency.

const ORG = "22222222-2222-2222-2222-222222222222" as Uuid;
const PROJECT = "33333333-3333-3333-3333-333333333333" as Uuid;
const RUN_ROW = "11111111-1111-1111-1111-111111111111";
const ACTOR = { id: "u1", type: "user" } as const;

let pg: PGlite;
let exec: SqlExecutor;

function event(seq: number, kind: string, jobId: string | undefined, payload: unknown): CoordinationEvent {
  return { seq, kind, runId: "r1", jobId, actor: ACTOR, at: "2026-06-19T00:00:00Z", idempotencyKey: `${jobId ?? "r1"}:${kind}:${seq}`, v: 1, payload } as CoordinationEvent;
}

const PLAN = { jobs: { a: { deps: [] as string[] }, b: { deps: ["a"] } } };

beforeEach(async () => {
  pg = new PGlite();
  exec = {
    async execute(text, params) {
      const r = await pg.query(text, (params ?? []) as unknown[]);
      return { rows: r.rows as never[], rowCount: r.affectedRows ?? r.rows.length };
    },
  };
  await pg.exec(`
    CREATE SCHEMA state;
    CREATE TABLE state.runs (
      id uuid PRIMARY KEY, org_id uuid, project_id uuid, run_ulid text,
      plan_digest text, status text NOT NULL DEFAULT 'pending',
      last_seq bigint NOT NULL DEFAULT 0,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE state.run_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, project_id uuid,
      run_id uuid, job_id text, status text NOT NULL DEFAULT 'queued',
      runner_id text, lease_expires_at timestamptz, attempt int NOT NULL DEFAULT 1,
      error_text text, updated_at timestamptz DEFAULT now()
    );
    INSERT INTO state.runs (id, org_id, project_id, run_ulid, plan_digest, status, last_seq)
      VALUES ('${RUN_ROW}', '${ORG}', '${PROJECT}', 'r1', 'sha256:p', 'pending', 0);
    INSERT INTO state.run_jobs (org_id, project_id, run_id, job_id, status)
      VALUES ('${ORG}','${PROJECT}','${RUN_ROW}','a','queued'),
             ('${ORG}','${PROJECT}','${RUN_ROW}','b','queued');
  `);
});

async function row(table: string, jobId?: string) {
  const q = jobId
    ? `SELECT * FROM state.run_jobs WHERE job_id = '${jobId}'`
    : `SELECT * FROM state.runs WHERE run_ulid = 'r1'`;
  return (await pg.query(q)).rows[0] as Record<string, unknown>;
}

describe("applyProjection — seq-guarded UPSERT into the read model", () => {
  it("projects a claim: run→running, job→claimed with holder/lease", async () => {
    const events = [
      event(1, K.RUN_CREATED, undefined, { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null }),
      event(2, K.JOB_CLAIMED, "a", { runnerId: "runner-1", leaseEpoch: 1, leaseExpiresAt: "2026-12-01T00:00:00Z", attempt: 1 }),
    ];
    const plan = planProjection(reduce(events, PLAN), 0);
    const res = await applyProjection(exec, { orgId: ORG, projectId: PROJECT }, plan);
    expect(res.applied).toBe(true);

    const run = await row("runs");
    expect(run.status).toBe("running");
    expect(Number(run.last_seq)).toBe(2);
    const a = await row("run_jobs", "a");
    expect(a.status).toBe("claimed");
    expect(a.runner_id).toBe("runner-1");
    expect(a.lease_expires_at).not.toBeNull();
    const b = await row("run_jobs", "b");
    expect(b.status).toBe("queued"); // untouched
  });

  it("is idempotent: re-applying the same fold writes nothing (guard)", async () => {
    const events = [
      event(1, K.RUN_CREATED, undefined, { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null }),
      event(2, K.JOB_CLAIMED, "a", { runnerId: "runner-1", leaseEpoch: 1, leaseExpiresAt: "2026-12-01T00:00:00Z", attempt: 1 }),
    ];
    const plan = planProjection(reduce(events, PLAN), 0);
    await applyProjection(exec, { orgId: ORG, projectId: PROJECT }, plan);
    // appliedSeq is irrelevant to the SQL guard: the row's last_seq is now 2, so a
    // second apply of the same (lastSeq=2) plan must no-op.
    const second = await applyProjection(exec, { orgId: ORG, projectId: PROJECT }, plan);
    expect(second.applied).toBe(false);
    expect(Number((await row("runs")).last_seq)).toBe(2);
  });

  it("advances on a strictly-newer fold (claim → succeed)", async () => {
    const base = [
      event(1, K.RUN_CREATED, undefined, { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null }),
      event(2, K.JOB_CLAIMED, "a", { runnerId: "runner-1", leaseEpoch: 1, leaseExpiresAt: "2026-12-01T00:00:00Z", attempt: 1 }),
    ];
    await applyProjection(exec, { orgId: ORG, projectId: PROJECT }, planProjection(reduce(base, PLAN), 0));

    const next = [...base, event(3, K.JOB_SUCCEEDED, "a", { runnerId: "runner-1", leaseEpoch: 1, resultDigest: "sha256:ra" })];
    const res = await applyProjection(exec, { orgId: ORG, projectId: PROJECT }, planProjection(reduce(next, PLAN), 2));
    expect(res.applied).toBe(true);
    expect(Number((await row("runs")).last_seq)).toBe(3);
    expect((await row("run_jobs", "a")).status).toBe("succeeded");
  });

  it("no-ops a non-apply plan (idempotency gate upstream)", async () => {
    const plan = planProjection(reduce([], PLAN), 0); // empty fold, lastSeq 0
    const res = await applyProjection(exec, { orgId: ORG, projectId: PROJECT }, plan);
    expect(res.applied).toBe(false);
  });
});
