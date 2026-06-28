import {
  CATALOG_PAGE_SIZE,
  collectOrgCatalog,
  encodeCursor,
  type CatalogPage,
  type CatalogPageQuery,
} from "@web-console-next/lib/catalog-portal/fetch";
import type { OrgCatalogEntity, StateCursor } from "@saas/contracts/state";

function entity(ref: string): OrgCatalogEntity {
  return {
    orgId: "org_1",
    sourceProjectId: "prj_1",
    sourceEnvironment: "prod",
    sourceCommit: "abc123",
    headDigest: "sha256:deadbeef",
    entityRef: ref,
    name: ref,
    kind: "Component",
    owner: null,
    lifecycle: null,
    relations: [],
  };
}

function cursor(id: string): StateCursor {
  return { createdAt: "2026-01-01T00:00:00.000Z", id };
}

describe("collectOrgCatalog", () => {
  it("returns a single page and stops when there is no next cursor", async () => {
    const calls: CatalogPageQuery[] = [];
    const fetchPage = async (q: CatalogPageQuery): Promise<CatalogPage> => {
      calls.push(q);
      return { entities: [entity("component:default/a")], nextCursor: null };
    };

    const out = await collectOrgCatalog(fetchPage);

    expect(out.map((e) => e.entityRef)).toEqual(["component:default/a"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ limit: CATALOG_PAGE_SIZE });
  });

  it("walks the cursor across pages and merges in order", async () => {
    const pages: CatalogPage[] = [
      { entities: [entity("a"), entity("b")], nextCursor: cursor("b") },
      { entities: [entity("c"), entity("d")], nextCursor: cursor("d") },
      { entities: [entity("e")], nextCursor: null },
    ];
    const seen: CatalogPageQuery[] = [];
    let i = 0;
    const fetchPage = async (q: CatalogPageQuery): Promise<CatalogPage> => {
      seen.push(q);
      return pages[i++]!;
    };

    const out = await collectOrgCatalog(fetchPage);

    expect(out.map((e) => e.entityRef)).toEqual(["a", "b", "c", "d", "e"]);
    // Page 1 has no cursor; pages 2/3 thread the previous nextCursor.
    expect(seen[0]).toEqual({ limit: CATALOG_PAGE_SIZE });
    expect(seen[1]!.cursor).toBe(encodeCursor(cursor("b")));
    expect(seen[2]!.cursor).toBe(encodeCursor(cursor("d")));
  });

  it("stops at maxPages even when the server keeps returning a cursor", async () => {
    let n = 0;
    const fetchPage = async (): Promise<CatalogPage> => {
      n += 1;
      return { entities: [entity(`e${n}`)], nextCursor: cursor(`e${n}`) };
    };

    const out = await collectOrgCatalog(fetchPage, { maxPages: 3 });

    expect(out).toHaveLength(3);
    expect(n).toBe(3);
  });

  it("emits progressive snapshots to onPage after every page", async () => {
    const pages: CatalogPage[] = [
      { entities: [entity("a")], nextCursor: cursor("a") },
      { entities: [entity("b")], nextCursor: null },
    ];
    let i = 0;
    const snapshots: number[] = [];

    await collectOrgCatalog(async () => pages[i++]!, {
      onPage: (soFar) => snapshots.push(soFar.length),
    });

    expect(snapshots).toEqual([1, 2]);
  });

  it("propagates a fetch error", async () => {
    const fetchPage = async (): Promise<CatalogPage> => {
      throw new Error("boom");
    };
    await expect(collectOrgCatalog(fetchPage)).rejects.toThrow("boom");
  });

  it("encodes a keyset cursor as createdAt|id", () => {
    expect(encodeCursor(cursor("xyz"))).toBe("2026-01-01T00:00:00.000Z|xyz");
  });
});
