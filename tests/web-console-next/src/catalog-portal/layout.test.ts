import { buildBoard, buildMap } from "@web-console-next/lib/catalog-portal/layout";
import { service } from "./fixture";

const services = [
  service({ entityRef: "component:default/api", lifecycle: "production", system: "Checkout", relations: [{ type: "dependsOn", targetRef: "component:default/ledger" }] }),
  service({ entityRef: "component:default/ledger", lifecycle: "production", system: "Checkout" }),
  service({ entityRef: "component:default/reco", lifecycle: "experimental", system: "Growth" }),
  service({ entityRef: "component:default/old", lifecycle: "deprecated", system: "Platform" }),
  service({ entityRef: "resource:default/db", kind: "Resource", system: "Checkout" }),
];

describe("buildBoard", () => {
  it("buckets services into the four lifecycle + infra columns", () => {
    const cols = buildBoard(services);
    expect(cols.map((c) => c.key)).toEqual(["production", "experimental", "deprecated", "infra"]);
    expect(cols.find((c) => c.key === "production")!.count).toBe(2);
    expect(cols.find((c) => c.key === "experimental")!.count).toBe(1);
    expect(cols.find((c) => c.key === "infra")!.count).toBe(1); // the resource
  });
});

describe("buildMap", () => {
  it("lays out non-resource nodes in system columns with edges between deps", () => {
    const m = buildMap(services);
    expect(m.count).toBe(4); // resources excluded
    expect(m.columns).toEqual(["Checkout", "Growth", "Platform"]); // alphabetical
    // api → ledger edge exists (both in Checkout)
    const api = m.nodes.find((n) => n.name === "api")!;
    const ledger = m.nodes.find((n) => n.name === "ledger")!;
    expect(m.edges.some((e) => e.fromKey === api.key && e.toKey === ledger.key)).toBe(true);
    // every node has a percentage position in range
    for (const n of m.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(100);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(100);
    }
  });

  it("drops edges to unmapped (resource / missing) targets", () => {
    const s = [
      service({ entityRef: "component:default/web", system: "Growth", relations: [{ type: "dependsOn", targetRef: "resource:default/cache" }] }),
      service({ entityRef: "resource:default/cache", kind: "Resource", system: "Growth" }),
    ];
    const m = buildMap(s);
    expect(m.count).toBe(1);
    expect(m.edges).toHaveLength(0);
  });
});
