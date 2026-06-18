import { computeInsights, filterByInsight } from "@web-console-next/lib/catalog-insights";
import type { OrgCatalogEntity } from "@saas/contracts/state";

function entity(partial: Partial<OrgCatalogEntity> & Pick<OrgCatalogEntity, "entityRef" | "name">): OrgCatalogEntity {
  return {
    orgId: "org_1",
    sourceProjectId: "prj_1",
    sourceEnvironment: "prod",
    sourceCommit: "abc",
    headDigest: "sha256:x",
    kind: "Component",
    owner: "team-a",
    lifecycle: "production",
    relations: [],
    ...partial,
  };
}

const entities: OrgCatalogEntity[] = [
  entity({ entityRef: "component:default/api", name: "api", relations: [{ type: "dependsOn", targetRef: "resource:default/db" }] }),
  entity({ entityRef: "resource:default/db", name: "db", owner: null }),
  entity({ entityRef: "component:default/web", name: "web", lifecycle: null, relations: [{ type: "dependsOn", targetRef: "component:default/ghost" }] }),
];

describe("computeInsights", () => {
  it("counts owner / lifecycle gaps and dangling dependencies", () => {
    const ins = computeInsights(entities);
    expect(ins.total).toBe(3);
    expect(ins.counts["missing-owner"]).toBe(1); // db
    expect(ins.counts["missing-lifecycle"]).toBe(1); // web
    expect(ins.counts["dangling-deps"]).toBe(1); // web → ghost (not present); api → db resolves
  });

  it("reports owner coverage as a percentage", () => {
    expect(computeInsights(entities).ownedPct).toBe(67); // 2 of 3 owned → 66.7 → 67
  });

  it("is zero-safe on an empty catalog", () => {
    expect(computeInsights([])).toEqual({
      total: 0,
      ownedPct: 0,
      counts: { "missing-owner": 0, "missing-lifecycle": 0, "dangling-deps": 0 },
    });
  });
});

describe("filterByInsight", () => {
  it("returns just the offending entities per insight", () => {
    expect(filterByInsight(entities, "missing-owner").map((e) => e.name)).toEqual(["db"]);
    expect(filterByInsight(entities, "missing-lifecycle").map((e) => e.name)).toEqual(["web"]);
    expect(filterByInsight(entities, "dangling-deps").map((e) => e.name)).toEqual(["web"]);
  });
});
