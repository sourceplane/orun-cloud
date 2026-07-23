// IC5 — the catalog-doc digest resolve path. The audit measured 1.0–1.3s per
// doc open: the old single UNION ran two leading-wildcard LIKE legs (forced
// sequential scans) on EVERY open even though the exact, index-backed
// catalog_docs leg answers every doc attached since CD3. Guards here:
// (a) an indexed doc costs exactly ONE query with no LIKE leg;
// (b) the LIKE fallback still runs — only — when the doc index misses;
// (c) the doc response declares its immutability (cache-control) so the
//     edge read-through and browsers can serve repeat opens for free.

import { createStateRepository } from "@saas/db/state";
import { handleGetOrgCatalogDoc } from "@state-worker/handlers/repo-facets";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ORG_PUBLIC = `org_${ORG.replace(/-/g, "")}`;
const PROJECT_PUBLIC = `prj_${PROJECT.replace(/-/g, "")}`;
const DIGEST = "sha256:" + "d".repeat(64);
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

function trackingExecutor(catalogDocRows: Record<string, unknown>[], legacyRows: Record<string, unknown>[]) {
  const queries: string[] = [];
  const executor: SqlExecutor = {
    execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
      queries.push(text);
      const out = text.includes("FROM state.catalog_docs")
        ? catalogDocRows
        : text.includes("LIKE")
          ? legacyRows
          : [];
      return Promise.resolve({ rows: out as unknown as T[], rowCount: out.length });
    },
  };
  return { executor, queries };
}

describe("IC5 — findCatalogDocProject digest path", () => {
  it("resolves an indexed doc in ONE exact-match query — no LIKE legs executed", async () => {
    const { executor, queries } = trackingExecutor([{ source_project_id: PROJECT }], []);
    const repo = createStateRepository(executor);
    const res = await repo.findCatalogDocProject(asUuid(ORG), DIGEST);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(PROJECT);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("FROM state.catalog_docs");
    expect(queries[0]).not.toContain("LIKE");
  });

  it("falls back to the encoding-agnostic LIKE legs only when the doc index misses", async () => {
    const { executor, queries } = trackingExecutor([], [{ source_project_id: PROJECT }]);
    const repo = createStateRepository(executor);
    const res = await repo.findCatalogDocProject(asUuid(ORG), DIGEST);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(PROJECT);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("LIKE");
    expect(queries[1]).toContain("state.repo_facet");
    expect(queries[1]).toContain("state.org_catalog_entities");
  });

  it("returns null (not error) when neither path matches", async () => {
    const { executor } = trackingExecutor([], []);
    const repo = createStateRepository(executor);
    const res = await repo.findCatalogDocProject(asUuid(ORG), DIGEST);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBeNull();
  });
});

// ── handler: immutable-by-digest response headers ───────────

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

function framedBlob(kind: string, body: string): Uint8Array {
  const enc = new TextEncoder();
  const bodyBytes = enc.encode(body);
  const header = enc.encode(`${kind} ${bodyBytes.length}\x00`);
  const out = new Uint8Array(header.length + bodyBytes.length);
  out.set(header, 0);
  out.set(bodyBytes, header.length);
  return out;
}

describe("IC5 — doc response is immutable-by-digest", () => {
  it("carries cache-control: public, max-age=31536000, immutable", async () => {
    const MD = "# Overview";
    const KEY = `state/${ORG_PUBLIC}/${PROJECT_PUBLIC}/objects/${DIGEST}`;
    const framed = framedBlob("blob", MD);
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_DB: { connectionString: "postgres://fake" },
      MEMBERSHIP_WORKER: fetcherAllow(),
      POLICY_WORKER: fetcherAllow(),
      ORUN_STATE: {
        get: (k: string) =>
          k === KEY
            ? Promise.resolve({ arrayBuffer: () => Promise.resolve(framed.buffer) })
            : Promise.resolve(null),
      },
    } as unknown as Env;
    const { executor } = trackingExecutor([{ source_project_id: PROJECT }], []);
    const res = await handleGetOrgCatalogDoc(
      new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/catalog/doc?digest=${encodeURIComponent(DIGEST)}`),
      env,
      "req_1",
      ACTOR,
      asUuid(ORG),
      { executor },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MD);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
