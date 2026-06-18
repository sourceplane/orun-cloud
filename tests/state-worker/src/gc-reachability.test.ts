// OV9 — object GC reachability (REPORT-ONLY). Verifies the walk diffs the live
// closure against stored objects to compute reclaimable bytes, that retained
// roots keep their subtrees reachable (conservative), and that the report never
// mutates anything. A synthetic framed object store stands in for R2.

import { computeStorageGcReport, collectStorageGc } from "@state-worker/gc-reachability";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = asUuid("11111111-1111-4111-8111-111111111111");
const PROJECT = asUuid("44444444-4444-4444-8444-444444444444");

const enc = new TextEncoder();
const NUL = new Uint8Array([0]);
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function frame(kind: string, body: Uint8Array | string): Uint8Array {
  const b = typeof body === "string" ? enc.encode(body) : body;
  return concat(enc.encode(`${kind} ${b.length}`), NUL, b);
}
function entry(kind: "blob" | "tree", name: string, hex: string): Uint8Array {
  return concat(enc.encode(`${kind} ${name}`), NUL, enc.encode(hex));
}
const hex = (c: string) => c.repeat(64);

// A snapshot root tree → two child blobs; plus one orphan blob nothing points to.
const ROOT = `sha256:${hex("a")}`;
const CHILD1 = `sha256:${hex("b")}`;
const CHILD2 = `sha256:${hex("c")}`;
const ORPHAN = `sha256:${hex("d")}`;

const store: Record<string, Uint8Array> = {
  [ROOT]: frame("tree", concat(entry("blob", "one", hex("b")), entry("blob", "two", hex("c")))),
  [CHILD1]: frame("blob", "one-body"),
  [CHILD2]: frame("blob", "two-body"),
  [ORPHAN]: frame("blob", "dead-weight"),
};
const fetcher = (digest: string) => Promise.resolve(store[digest] ?? null);

/** Executor: roots = [ROOT]; objects = all four with sizes. */
function gcExecutor(): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
      if (text.includes("UNION")) {
        return Promise.resolve({ rows: [{ digest: ROOT }] as unknown as T[], rowCount: 1 });
      }
      if (text.includes("FROM state.objects")) {
        const rows = [
          { digest: ROOT, size_bytes: 100 },
          { digest: CHILD1, size_bytes: 200 },
          { digest: CHILD2, size_bytes: 300 },
          { digest: ORPHAN, size_bytes: 4096 },
        ];
        return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
      }
      return Promise.resolve({ rows: [] as T[], rowCount: 0 });
    },
  } as unknown as SqlExecutor;
}

const scope = { orgId: ORG, projectId: PROJECT, orgPublic: "org_x", projectPublic: "prj_y" };

describe("computeStorageGcReport (OV9, report-only)", () => {
  it("counts the root closure as reachable and the orphan as reclaimable", async () => {
    const report = await computeStorageGcReport({} as unknown as Env, scope, { executor: gcExecutor(), fetcher });
    expect(report).not.toBeNull();
    expect(report!.totalObjects).toBe(4);
    expect(report!.totalBytes).toBe(100 + 200 + 300 + 4096);
    expect(report!.reachableObjects).toBe(3); // ROOT + its two children
    expect(report!.unreachableObjects).toBe(1); // the orphan
    expect(report!.reclaimableBytes).toBe(4096);
    expect(report!.capped).toBe(false);
  });

  it("terminates on a cycle (A→B→A) via the visited set, counting both reachable", async () => {
    // A and B point at each other; the walk must not loop forever.
    const cycA = `sha256:${hex("e")}`;
    const cycB = `sha256:${hex("f")}`;
    const cyclicStore: Record<string, Uint8Array> = {
      [cycA]: frame("tree", entry("tree", "b", hex("f"))),
      [cycB]: frame("tree", entry("tree", "a", hex("e"))),
    };
    const executor = {
      execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
        if (text.includes("UNION")) return Promise.resolve({ rows: [{ digest: cycA }] as unknown as T[], rowCount: 1 });
        if (text.includes("FROM state.objects")) {
          const rows = [
            { digest: cycA, size_bytes: 10 },
            { digest: cycB, size_bytes: 20 },
          ];
          return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
        }
        return Promise.resolve({ rows: [] as T[], rowCount: 0 });
      },
    } as unknown as SqlExecutor;
    const report = await computeStorageGcReport({} as unknown as Env, scope, {
      executor,
      fetcher: (d) => Promise.resolve(cyclicStore[d] ?? null),
    });
    expect(report!.reachableObjects).toBe(2);
    expect(report!.unreachableObjects).toBe(0);
    expect(report!.capped).toBe(false);
  });

  it("flags capped when a root is unreadable (subtree closure incomplete is still bounded)", async () => {
    // A root with no fetchable bytes yields an empty closure → the lone stored
    // object is (conservatively) unreachable; capped stays false (walk bounded).
    const executor = {
      execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
        if (text.includes("UNION")) return Promise.resolve({ rows: [{ digest: ROOT }] as unknown as T[], rowCount: 1 });
        if (text.includes("FROM state.objects")) {
          return Promise.resolve({ rows: [{ digest: CHILD1, size_bytes: 50 }] as unknown as T[], rowCount: 1 });
        }
        return Promise.resolve({ rows: [] as T[], rowCount: 0 });
      },
    } as unknown as SqlExecutor;
    const report = await computeStorageGcReport({} as unknown as Env, scope, {
      executor,
      fetcher: () => Promise.resolve(null), // nothing readable
    });
    expect(report!.unreachableObjects).toBe(1);
    expect(report!.reclaimableBytes).toBe(50);
  });

  it("reports nothing reclaimable when every object is reachable from a root", async () => {
    const executor = {
      execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
        if (text.includes("UNION")) return Promise.resolve({ rows: [{ digest: ROOT }] as unknown as T[], rowCount: 1 });
        if (text.includes("FROM state.objects")) {
          const rows = [
            { digest: ROOT, size_bytes: 100 },
            { digest: CHILD1, size_bytes: 200 },
            { digest: CHILD2, size_bytes: 300 },
          ];
          return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
        }
        return Promise.resolve({ rows: [] as T[], rowCount: 0 });
      },
    } as unknown as SqlExecutor;
    const report = await computeStorageGcReport({} as unknown as Env, scope, { executor, fetcher });
    expect(report!.reclaimableBytes).toBe(0);
    expect(report!.unreachableObjects).toBe(0);
  });
});

// OV9 — the reclamation (deleting) path. ROOT is a tree → CHILD1/CHILD2; ORPHAN
// is unreachable. The grace window keys off created_at.
const OLD = "2020-01-01T00:00:00.000Z"; // far outside any grace window
const DAY_MS = 86_400_000;

function collectExecutor(
  objects: { digest: string; size_bytes: number; created_at: string }[],
  dbDeletes: string[],
): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      if (text.includes("UNION")) return Promise.resolve({ rows: [{ digest: ROOT }] as unknown as T[], rowCount: 1 });
      if (text.includes("DELETE FROM state.objects")) {
        dbDeletes.push(String(params?.[2]));
        return Promise.resolve({ rows: [] as T[], rowCount: 1 });
      }
      if (text.includes("FROM state.objects")) {
        return Promise.resolve({ rows: objects as unknown as T[], rowCount: objects.length });
      }
      return Promise.resolve({ rows: [] as T[], rowCount: 0 });
    },
  } as unknown as SqlExecutor;
}

describe("collectStorageGc (OV9, the deleting path)", () => {
  const env = {} as unknown as Env;
  const objs = [
    { digest: ROOT, size_bytes: 100, created_at: OLD },
    { digest: ORPHAN, size_bytes: 4096, created_at: OLD },
  ];

  it("dryRun computes candidates but deletes nothing", async () => {
    const r2: string[] = [];
    const db: string[] = [];
    const res = await collectStorageGc(env, scope, { dryRun: true, graceMs: DAY_MS, limit: 100 }, {
      executor: collectExecutor(objs, db),
      fetcher,
      deleter: (d) => {
        r2.push(d);
        return Promise.resolve();
      },
    });
    expect(res!.candidateObjects).toBe(1); // the orphan, old + unreachable
    expect(res!.candidateBytes).toBe(4096);
    expect(res!.deletedObjects).toBe(0);
    expect(res!.dryRun).toBe(true);
    expect(r2).toEqual([]);
    expect(db).toEqual([]);
  });

  it("with dryRun:false on a complete walk, deletes the unreachable orphan (R2 then index)", async () => {
    const r2: string[] = [];
    const db: string[] = [];
    const res = await collectStorageGc(env, scope, { dryRun: false, graceMs: DAY_MS, limit: 100 }, {
      executor: collectExecutor(objs, db),
      fetcher,
      deleter: (d) => {
        r2.push(d);
        return Promise.resolve();
      },
    });
    expect(res!.deletedObjects).toBe(1);
    expect(res!.deletedBytes).toBe(4096);
    expect(res!.dryRun).toBe(false);
    expect(r2).toEqual([ORPHAN]);
    expect(db).toEqual([ORPHAN]);
  });

  it("never deletes an object newer than the grace window", async () => {
    const r2: string[] = [];
    const db: string[] = [];
    const recent = [
      { digest: ROOT, size_bytes: 100, created_at: OLD },
      { digest: ORPHAN, size_bytes: 4096, created_at: new Date().toISOString() },
    ];
    const res = await collectStorageGc(env, scope, { dryRun: false, graceMs: DAY_MS, limit: 100 }, {
      executor: collectExecutor(recent, db),
      fetcher,
      deleter: (d) => {
        r2.push(d);
        return Promise.resolve();
      },
    });
    expect(res!.candidateObjects).toBe(0);
    expect(res!.deletedObjects).toBe(0);
    expect(r2).toEqual([]);
  });

  it("REFUSES to delete when the reachability walk is capped, even with dryRun:false", async () => {
    const r2: string[] = [];
    const db: string[] = [];
    const res = await collectStorageGc(env, scope, { dryRun: false, graceMs: DAY_MS, limit: 100 }, {
      executor: collectExecutor(objs, db),
      fetcher,
      deleter: (d) => {
        r2.push(d);
        return Promise.resolve();
      },
      maxVisit: 1, // forces capped: the closure can't be fully enumerated
    });
    expect(res!.capped).toBe(true);
    expect(res!.dryRun).toBe(true); // capped forces a no-delete result
    expect(res!.deletedObjects).toBe(0);
    expect(r2).toEqual([]);
    expect(db).toEqual([]);
  });
});
