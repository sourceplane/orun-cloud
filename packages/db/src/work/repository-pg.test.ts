import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import type { SqlExecutor, TransactionalSqlExecutor } from "../hyperdrive/executor.js";
import { EVENT_KINDS } from "./model.js";
import { createWorkRepository } from "./repository.js";
import type { WorkRepository, WorkspaceScope } from "./types.js";

// Integration test for the POSTGRES work repository against a real Postgres
// engine (pglite, in-process WASM) with the REAL work migrations applied in
// production order. The memory repository covers semantics; this covers the
// SQL — it exists because the WH6 dogfood import failed in production on a
// path no test had ever executed: work.events carried BOTH the original
// inline v2 kind CHECK (auto-named events_kind_check by Postgres) and the
// regenerated 27-kind work_events_kind_check, because 660/700 dropped the
// wrong constraint name (a silent IF EXISTS no-op). Every kind added after
// v2 was rejected at insert. Migration 720 repairs it; the "exactly one
// CHECK, all 27 kinds insertable" assertions below are the regression.

const MIGRATIONS = [
  "200_work_foundation",
  "490_work_teardown",
  "560_work_foundation_v2",
  "660_work_v3_intent_plane",
  "690_work_v3_board_intent",
  "700_work_v4_hierarchy",
  "710_work_v4_snapshots",
  "720_work_events_kind_check_repair",
];

const scope: WorkspaceScope = { orgId: "11111111-1111-1111-1111-111111111111" };
const human = { type: "user" as const, id: "usr_1" };
const importActor = { ...human, via: "import" };

let db: PGlite;
let sql: TransactionalSqlExecutor;
let repo: WorkRepository;

function executorFor(client: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): SqlExecutor {
  return {
    async execute(text, params) {
      const r = await client.query(text, params ?? []);
      return { rows: r.rows as never[], rowCount: r.rows.length };
    },
  };
}

beforeAll(async () => {
  db = new PGlite();
  for (const m of MIGRATIONS) {
    const up = readFileSync(new URL(`../migrations/${m}/up.sql`, import.meta.url), "utf8");
    await db.exec(up);
  }
  sql = {
    ...executorFor(db),
    async transaction(fn) {
      return db.transaction(async (tx) => fn(executorFor(tx as never))) as never;
    },
  };
  repo = createWorkRepository(sql);
}, 120_000);

describe("the migrated schema", () => {
  it("carries exactly ONE kind CHECK on work.events (the 660/700 wrong-name drop is repaired)", async () => {
    const res = await sql.execute(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'work.events'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%kind%'`,
    );
    expect(res.rows.map((r) => r.conname)).toEqual(["work_events_kind_check"]);
  });

  it("accepts an insert of EVERY coordination kind — the closed 27-kind vocabulary, nothing missing", async () => {
    expect(EVENT_KINDS).toHaveLength(27);
    for (const [i, kind] of EVENT_KINDS.entries()) {
      await sql.execute(
        `INSERT INTO work.events (org_id, subject, kind, actor, payload, seq)
         VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, $5)`,
        ["99999999-9999-9999-9999-999999999999", "VOC-1", kind, JSON.stringify(human), i + 1],
      );
    }
    const res = await sql.execute(`SELECT count(*)::int AS n FROM work.events WHERE org_id = $1`, [
      "99999999-9999-9999-9999-999999999999",
    ]);
    expect(Number(res.rows[0]!.n)).toBe(27);
  });

  it("still rejects a lifecycle-write kind at the database (WP-3 holds below the model)", async () => {
    await expect(
      sql.execute(
        `INSERT INTO work.events (org_id, subject, kind, actor, payload, seq)
         VALUES ($1, 'VOC-2', 'status_set', $2::jsonb, '{}'::jsonb, 1000)`,
        ["99999999-9999-9999-9999-999999999999", JSON.stringify(human)],
      ),
    ).rejects.toThrow(/work_events_kind_check/);
  });
});

describe("the WH6 import sequence through the real SQL", () => {
  it("initiative → epic → milestones → key-preserving migration → milestone task, then approve seals a verifiable brief", async () => {
    await repo.createInitiative(scope, { slug: "platform", title: "Platform", actor: importActor });
    await repo.createSpec(scope, {
      slug: "saas-baseline",
      title: "SaaS baseline",
      docRef: "sha256:" + "ab".repeat(32),
      initiative: "platform",
      actor: importActor,
    });

    // The exact production failure point: the first milestone_edited append.
    await repo.editMilestone(scope, {
      epicKey: "saas-baseline",
      op: "create",
      key: "B1",
      title: "Real authentication",
      goal: "Users sign in",
      doneWhen: ["login works"],
      ordinal: 0,
      actor: importActor,
    });
    await repo.editMilestone(scope, {
      epicKey: "saas-baseline",
      op: "create",
      key: "B2",
      title: "Second milestone",
      actor: importActor,
    });

    // A pre-v4 flat-import task, then the key-preserving migration onto B1.
    const flat = await repo.createTask(scope, {
      prefix: "OGP",
      title: "B1 — Real authentication",
      specKey: "saas-baseline",
      labels: { "import.milestone": "B1", "import.spec": "saas-baseline" },
      actor: importActor,
    });
    await repo.setMilestone(scope, { key: flat.key, milestone: "B1", actor: importActor });

    // A fresh v4 task minted directly inside a milestone, deps rewritten.
    await repo.createTask(scope, {
      prefix: "OGP",
      title: "B2 — Second",
      specKey: "saas-baseline",
      milestone: "B2",
      contract: { goal: "g", deps: [flat.key] },
      labels: { "import.milestone": "B2", "import.spec": "saas-baseline" },
      actor: importActor,
    });

    const ladder = await repo.listMilestones(scope, "saas-baseline");
    expect(ladder.map((m) => m.key)).toEqual(["B1", "B2"]);
    const ws = await repo.getWorkSet(scope);
    expect(ws.tasks).toHaveLength(2);
    expect(ws.tasks.find((t) => t.key === flat.key)?.milestone).toBe("B1");

    // Approval seals in the same transaction; the brief round-trips by digest.
    await repo.putDocRevision(scope, { specKey: "saas-baseline", body: "# v1\n", actor: human });
    const out = await repo.approve(scope, { key: "saas-baseline", actor: human });
    expect(out.snapshot).toMatch(/^sha256:/);
    const brief = await repo.getEpicBrief(scope, "saas-baseline");
    expect(brief.id).toBe(out.snapshot);
    expect(brief.canonical.length).toBeGreaterThan(0);
  });
});
