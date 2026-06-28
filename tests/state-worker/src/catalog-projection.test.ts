// OV6.2b — the catalog projector. Builds a synthetic catalog snapshot (a root
// tree with components/ and entities/<Kind>/ subtrees of framed JSON blobs) in an
// injected object store, projects it, and asserts the org-global read model is
// replaced for the scope with the right entities + provenance. The framing is
// byte-identical to what the orun CLI writes, so this exercises the real walk.

import { projectCatalogSnapshot } from "@state-worker/catalog-projection";
import type { ObjectFetcher } from "@state-worker/object-model";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";

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
const hx = (c: string) => c.repeat(64);

// Build one catalog snapshot; returns the root digest + the object store map.
function buildSnapshot(): { rootDigest: string; store: Record<string, Uint8Array> } {
  const comp = hx("a");
  const sys = hx("b");
  const compsTree = hx("c");
  const sysKindTree = hx("d");
  const entitiesTree = hx("e");
  const root = hx("f");

  const componentBlob = frame(
    "blob",
    JSON.stringify({
      kind: "ComponentManifest",
      identity: { componentKey: "ns/repo/api", name: "api", namespace: "ns", repo: "repo" },
      ownership: { owner: "team-platform" },
      lifecycle: { stage: "production" },
      relations: [{ type: "dependsOn", to: "ns/repo/db", toKind: "Component" }],
      spec: { system: "Checkout", description: "The checkout API.", language: "Go", tags: ["public", "tier1"] },
    }),
  );
  const entityBlob = frame(
    "blob",
    JSON.stringify({
      apiVersion: "orun.io/v1",
      kind: "System",
      identity: { entityKey: "ns/repo/identity", kind: "System", name: "identity" },
      ownership: { owner: "team-identity" },
      lifecycle: { stage: "experimental" },
      spec: { description: "The identity system." },
    }),
  );

  const store: Record<string, Uint8Array> = {
    [`sha256:${comp}`]: componentBlob,
    [`sha256:${sys}`]: entityBlob,
    [`sha256:${compsTree}`]: frame("tree", entry("blob", "api.json", comp)),
    [`sha256:${sysKindTree}`]: frame("tree", entry("blob", "identity.json", sys)),
    [`sha256:${entitiesTree}`]: frame("tree", entry("tree", "System", sysKindTree)),
    // Root entries must be name-sorted: "components" < "entities".
    [`sha256:${root}`]: frame("tree", concat(entry("tree", "components", compsTree), entry("tree", "entities", entitiesTree))),
  };
  return { rootDigest: `sha256:${root}`, store };
}

function fetcherOf(store: Record<string, Uint8Array>): ObjectFetcher {
  return (digest: string) => Promise.resolve(store[digest] ?? null);
}

// Fake executor capturing the projector's DELETE + upsert INSERTs.
interface Capture {
  executor: SqlExecutor;
  deletes: number;
  upserts: unknown[][];
}
function captureExecutor(): Capture {
  const cap: Capture = { executor: undefined as unknown as SqlExecutor, deletes: 0, upserts: [] };
  cap.executor = {
    execute<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<SqlExecutorResult<T>> {
      if (text.includes("DELETE FROM state.org_catalog_entities")) {
        cap.deletes++;
        return Promise.resolve({ rows: [] as unknown as T[], rowCount: 2 });
      }
      if (text.includes("INSERT INTO state.org_catalog_entities")) {
        cap.upserts.push(params);
        const row = {
          id: params[0], org_id: params[1], entity_ref: params[2], kind: params[3], name: params[4],
          owner: params[5], lifecycle: params[6], relations: params[7],
          description: params[8], system: params[9], language: params[10], tags: params[11],
          source_project_id: params[12], source_environment: params[13], source_commit: params[14],
          head_digest: params[15],
          created_at: "2026-06-18T00:00:00.000Z", updated_at: "2026-06-18T00:00:00.000Z",
        };
        return Promise.resolve({ rows: [row] as unknown as T[], rowCount: 1 });
      }
      return Promise.resolve({ rows: [] as unknown as T[], rowCount: 0 });
    },
  } as unknown as SqlExecutor;
  return cap;
}

function scope(over?: Partial<Record<string, unknown>>) {
  return {
    orgId: asUuid(ORG),
    projectId: asUuid(PROJECT),
    orgPublic: `org_${ORG.replace(/-/g, "")}`,
    projectPublic: `prj_${PROJECT.replace(/-/g, "")}`,
    environment: null,
    digest: "sha256:" + "f".repeat(64),
    commit: "abc123",
    ...over,
  };
}

describe("projectCatalogSnapshot (OV6.2b)", () => {
  it("walks the snapshot and replaces the scope with components + derived entities", async () => {
    const { rootDigest, store } = buildSnapshot();
    const cap = captureExecutor();
    const summary = await projectCatalogSnapshot({} as Env, scope({ digest: rootDigest }), {
      executor: cap.executor,
      fetcher: fetcherOf(store),
    });

    expect(summary).toEqual({ deleted: 2, projected: 2 });
    expect(cap.deletes).toBe(1); // replace-the-scope happened once
    expect(cap.upserts).toHaveLength(2);

    // params: [id, orgId, entityRef, kind, name, owner, lifecycle, relations(json),
    //          description, system, language, tags(json),
    //          sourceProjectId, sourceEnv, sourceCommit, headDigest]
    const byRef = new Map(cap.upserts.map((p) => [p[2] as string, p]));
    const comp = byRef.get("ns/repo/api")!;
    expect(comp[3]).toBe("Component");
    expect(comp[4]).toBe("api");
    expect(comp[5]).toBe("team-platform"); // owner from ownership.owner
    expect(comp[6]).toBe("production"); // lifecycle from lifecycle.stage
    expect(JSON.parse(comp[7] as string)).toEqual([{ type: "dependsOn", targetRef: "ns/repo/db" }]);
    // Git-authored portal fields (CP4).
    expect(comp[8]).toBe("The checkout API."); // description from spec
    expect(comp[9]).toBe("Checkout"); // system from spec
    expect(comp[10]).toBe("Go"); // language from spec
    expect(JSON.parse(comp[11] as string)).toEqual(["public", "tier1"]); // tags
    // Provenance.
    expect(comp[12]).toBe(PROJECT);
    expect(comp[13]).toBeNull(); // project-wide head
    expect(comp[14]).toBe("abc123");
    expect(comp[15]).toBe(rootDigest);

    const sys = byRef.get("ns/repo/identity")!;
    expect(sys[3]).toBe("System"); // derived entity kind
    expect(sys[5]).toBe("team-identity");
    expect(sys[6]).toBe("experimental");
    expect(sys[8]).toBe("The identity system."); // derived-entity description from spec
  });

  it("clears the scope even when the snapshot root is unreadable (head points at a gone object)", async () => {
    const cap = captureExecutor();
    const summary = await projectCatalogSnapshot({} as Env, scope(), {
      executor: cap.executor,
      fetcher: () => Promise.resolve(null), // nothing in the store
    });
    expect(summary).toEqual({ deleted: 2, projected: 0 });
    expect(cap.deletes).toBe(1);
    expect(cap.upserts).toHaveLength(0);
  });

  it("is a dormant no-op when neither R2 nor a DB executor is available", async () => {
    const summary = await projectCatalogSnapshot({} as Env, scope(), {});
    expect(summary).toBeNull();
  });
});
