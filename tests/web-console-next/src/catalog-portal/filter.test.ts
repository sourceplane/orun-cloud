import {
  EMPTY_FILTERS,
  activeChips,
  filterServices,
  groupServices,
  hasActiveFilters,
  sortServices,
} from "@web-console-next/lib/catalog-portal/filter";
import { annotateOwnership, ownershipCoverage, type OwnerResolution } from "@web-console-next/lib/catalog-portal/model";
import { service } from "./fixture";

const services = [
  service({ entityRef: "component:default/api", owner: "payments", lifecycle: "production", system: "Checkout", language: "Go" }, { health: "healthy", lastDeployHours: 5 }),
  service({ entityRef: "api:default/search", kind: "API", owner: "search", lifecycle: "production", system: "Growth" }, { health: "degraded", lastDeployHours: 1 }),
  service({ entityRef: "component:default/legacy", lifecycle: "deprecated", system: "Platform" }, { health: "down", lastDeployHours: 100 }),
  service({ entityRef: "resource:default/db", kind: "Resource", system: "Checkout" }),
];

describe("filterServices", () => {
  it("filters by kind", () => {
    expect(filterServices(services, { ...EMPTY_FILTERS, kind: "API" }).map((s) => s.name)).toEqual(["search"]);
  });
  it("filters by lifecycle and health", () => {
    expect(filterServices(services, { ...EMPTY_FILTERS, lifecycle: "deprecated" }).map((s) => s.name)).toEqual(["legacy"]);
    expect(filterServices(services, { ...EMPTY_FILTERS, health: "down" }).map((s) => s.name)).toEqual(["legacy"]);
  });
  it("filters by attention (unowned or unhealthy components)", () => {
    const names = filterServices(services, { ...EMPTY_FILTERS, attention: true }).map((s) => s.name).sort();
    expect(names).toEqual(["legacy", "search"]); // degraded api-search + down/unowned legacy; db is a resource
  });
  it("matches free text across name, owner, language, system", () => {
    expect(filterServices(services, { ...EMPTY_FILTERS, query: "go" }).map((s) => s.name)).toEqual(["api"]);
    expect(filterServices(services, { ...EMPTY_FILTERS, query: "growth" }).map((s) => s.name)).toEqual(["search"]);
  });

  it("filters to My services by the viewer's team ids (teams-ownership TO3)", () => {
    const byOwner = new Map<string, OwnerResolution>([
      ["payments", { owner: "payments", state: "owned", teamId: "team_pay", name: "Payments" }],
      ["search", { owner: "search", state: "owned", teamId: "team_srch", name: "Search" }],
    ]);
    const annotated = annotateOwnership(services, byOwner);
    const mineNames = filterServices(annotated, { ...EMPTY_FILTERS, mine: true }, new Set(["team_pay"])).map((s) => s.name);
    expect(mineNames).toEqual(["api"]); // only the Payments-owned entity
    // no team ids → nothing is "mine"
    expect(filterServices(annotated, { ...EMPTY_FILTERS, mine: true }, new Set()).length).toBe(0);
  });
});

describe("sortServices", () => {
  it("sorts by name asc/desc", () => {
    expect(sortServices(services, "name", "asc").map((s) => s.name)).toEqual(["search", "api", "legacy", "db"]);
    expect(sortServices(services, "name", "desc")[0]!.name).toBe("db");
  });
  it("sorts by health worst-first", () => {
    expect(sortServices(services, "health", "asc")[0]!.name).toBe("legacy"); // down ranks highest
  });
  it("sorts by deploy recency", () => {
    expect(sortServices(services, "deploy", "asc")[0]!.name).toBe("search"); // 1h ago is most recent
  });
});

describe("groupServices", () => {
  it("returns null when ungrouped", () => {
    expect(groupServices(services, "none")).toBeNull();
  });
  it("groups by system with attention sub-labels", () => {
    const groups = groupServices(services, "system")!;
    const checkout = groups.find((g) => g.label === "Checkout")!;
    expect(checkout.count).toBe(2);
    const platform = groups.find((g) => g.label === "Platform")!;
    expect(platform.sub).toBe("1 need attention");
  });
  it("sinks Unowned / No lifecycle groups to the bottom", () => {
    const byTeam = groupServices(services, "team")!;
    expect(byTeam[byTeam.length - 1]!.label).toBe("Unowned");
    const byLife = groupServices(services, "lifecycle")!;
    expect(byLife[byLife.length - 1]!.label).toBe("No lifecycle");
  });
});

describe("teams-ownership TO2: resolved ownership grouping", () => {
  it("groups by resolved team; unmapped and unowned bucket distinctly", () => {
    const raw = [
      service({ entityRef: "component:default/api", owner: "payments" }),
      service({ entityRef: "component:default/web", owner: "group:payments" }),
      service({ entityRef: "component:default/old", owner: "legacy" }),
      service({ entityRef: "resource:default/db" }), // no owner
    ];
    const byOwner = new Map<string, OwnerResolution>([
      ["payments", { owner: "payments", state: "owned", teamId: "team_p", name: "Payments", handle: "payments" }],
      ["group:payments", { owner: "group:payments", state: "owned", teamId: "team_p", name: "Payments", handle: "payments" }],
      ["legacy", { owner: "legacy", state: "unmapped" }],
    ]);
    const groups = groupServices(annotateOwnership(raw, byOwner), "team")!;
    const labels = groups.map((g) => g.label);
    expect(labels).toContain("Payments");
    expect(groups.find((g) => g.label === "Payments")!.count).toBe(2); // both spellings → one team
    expect(labels).toContain("Unmapped: legacy");
    expect(labels[labels.length - 1]).toBe("Unowned"); // truly unowned sinks last
  });
});

describe("teams-ownership TO5: ownership coverage", () => {
  it("computes coverage %, per-team counts, and the unmapped backlog", () => {
    const raw = [
      service({ entityRef: "component:default/a", owner: "payments" }),
      service({ entityRef: "component:default/b", owner: "payments" }),
      service({ entityRef: "component:default/c", owner: "search" }),
      service({ entityRef: "component:default/d", owner: "legacy" }),   // unmapped
      service({ entityRef: "component:default/e", owner: "legacy" }),   // unmapped (same string)
      service({ entityRef: "resource:default/db" }),                    // unowned
    ];
    const byOwner = new Map<string, OwnerResolution>([
      ["payments", { owner: "payments", state: "owned", teamId: "team_pay", name: "Payments" }],
      ["search", { owner: "search", state: "owned", teamId: "team_srch", name: "Search" }],
      ["legacy", { owner: "legacy", state: "unmapped" }],
    ]);
    const cov = ownershipCoverage(annotateOwnership(raw, byOwner));
    expect(cov).toMatchObject({ total: 6, owned: 3, unmapped: 2, unowned: 1, coveragePct: 50 });
    expect(cov.perTeam).toEqual([
      { teamId: "team_pay", name: "Payments", count: 2 },
      { teamId: "team_srch", name: "Search", count: 1 },
    ]);
    expect(cov.unmappedOwners).toEqual([{ owner: "legacy", count: 2 }]);
  });
});

describe("chips", () => {
  it("builds a chip per active facet", () => {
    const f = { query: "x", kind: "API", lifecycle: "all", health: "down", attention: true, mine: true };
    const chips = activeChips(f);
    expect(chips.map((c) => c.field)).toEqual(["kind", "health", "attention", "mine", "query"]);
    expect(hasActiveFilters(f)).toBe(true);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });
});
