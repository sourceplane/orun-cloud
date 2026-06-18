import { buildNeighborhood, buildOrgGraph, layoutGraph } from "@web-console-next/lib/catalog-graph";
import type { OrgCatalogEntity } from "@saas/contracts/state";

function entity(partial: Partial<OrgCatalogEntity> & Pick<OrgCatalogEntity, "entityRef" | "name" | "kind">): OrgCatalogEntity {
  return {
    orgId: "org_1",
    sourceProjectId: "prj_1",
    sourceEnvironment: "prod",
    sourceCommit: "abc123",
    headDigest: "sha256:deadbeef",
    owner: null,
    lifecycle: null,
    relations: [],
    ...partial,
  };
}

describe("buildNeighborhood", () => {
  const api = entity({
    entityRef: "component:default/api",
    name: "api",
    kind: "Component",
    relations: [
      { type: "dependsOn", targetRef: "resource:default/db" },
      { type: "providesApi", targetRef: "api:default/payments" },
      { type: "dependsOn", targetRef: "resource:default/db" }, // duplicate target
    ],
  });

  it("places the entity at the centre with one node per distinct target", () => {
    const g = buildNeighborhood(api, "acme");
    const center = g.nodes.find((n) => n.center)!;
    expect(center.ref).toBe("component:default/api");
    // centre + 2 distinct targets (db deduped)
    expect(g.nodes).toHaveLength(3);
    // one edge per relation (duplicates kept as edges)
    expect(g.edges).toHaveLength(3);
  });

  it("links target nodes to a route in the source's provenance scope", () => {
    const g = buildNeighborhood(api, "acme");
    const db = g.nodes.find((n) => n.ref === "resource:default/db")!;
    expect(db.href).toMatch(/^\/orgs\/acme\/catalog\/.+/);
    expect(db.kind).toBe("Resource");
  });
});

describe("buildOrgGraph", () => {
  it("draws edges only between loaded entities, matched by scope then ref", () => {
    const entities = [
      entity({ entityRef: "component:default/api", name: "api", kind: "Component", relations: [{ type: "dependsOn", targetRef: "resource:default/db" }] }),
      entity({ entityRef: "resource:default/db", name: "db", kind: "Resource" }),
      entity({ entityRef: "component:default/web", name: "web", kind: "Component", relations: [{ type: "dependsOn", targetRef: "component:default/missing" }] }),
    ];
    const g = buildOrgGraph(entities, "acme");
    expect(g.nodes).toHaveLength(3);
    // api→db resolves; web→missing is dropped (no loaded node).
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.type).toBe("dependsOn");
  });
});

describe("layoutGraph", () => {
  it("anchors the centre node and spreads the ring inside the unit box", () => {
    const g = buildNeighborhood(
      entity({
        entityRef: "component:default/api",
        name: "api",
        kind: "Component",
        relations: [
          { type: "dependsOn", targetRef: "resource:default/db" },
          { type: "dependsOn", targetRef: "resource:default/cache" },
        ],
      }),
      "acme",
    );
    const pos = layoutGraph(g);
    const center = pos.find((n) => n.center)!;
    expect(center.x).toBeCloseTo(0.5);
    expect(center.y).toBeCloseTo(0.5);
    for (const n of pos) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(1);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(1);
    }
  });
});
