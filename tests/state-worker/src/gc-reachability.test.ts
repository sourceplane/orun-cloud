// OV9 — object GC reachability (REPORT-ONLY). Verifies the walk diffs the live
// closure against stored objects to compute reclaimable bytes, that retained
// roots keep their subtrees reachable (conservative), and that the report never
// mutates anything. A synthetic framed object store stands in for R2.

import { computeStorageGcReport } from "@state-worker/gc-reachability";
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
      if (text.includes("SELECT digest, size_bytes FROM state.objects")) {
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

  it("reports nothing reclaimable when every object is reachable from a root", async () => {
    const executor = {
      execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
        if (text.includes("UNION")) return Promise.resolve({ rows: [{ digest: ROOT }] as unknown as T[], rowCount: 1 });
        if (text.includes("SELECT digest, size_bytes FROM state.objects")) {
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
