import {
  buildContext,
  buildSelected,
  computeChecks,
  decorateService,
  formatDeploy,
  isResource,
  lifecycleKey,
  needsAttention,
  ownerInitials,
  ownerLabel,
  rollup,
  scoreOf,
  scorecardOf,
  tierOf,
  toService,
} from "@web-console-next/lib/catalog-portal/model";
import { entity, service } from "./fixture";

describe("toService", () => {
  it("maps git-authored fields and derives the display name", () => {
    const s = toService(
      entity({ entityRef: "component:default/api", owner: "payments", lifecycle: "production", language: "Go", description: "An API." }),
    );
    expect(s.name).toBe("api");
    expect(s.kind).toBe("Component");
    expect(s.owner).toBe("payments");
    expect(s.language).toBe("Go");
    expect(s.description).toBe("An API.");
  });

  it("derives system from an explicit field, a System relation, then namespace", () => {
    expect(toService(entity({ entityRef: "component:default/a", system: "Checkout" })).system).toBe("Checkout");
    expect(
      toService(
        entity({ entityRef: "component:default/b", relations: [{ type: "partOf", targetRef: "system:default/Growth" }] }),
      ).system,
    ).toBe("Growth");
    expect(toService(entity({ entityRef: "component:shop/c" })).system).toBe("shop");
    expect(toService(entity({ entityRef: "component:default/d" })).system).toBe("Ungrouped");
  });

  it("excludes the part-of-system edge from deps but keeps real dependencies", () => {
    const s = toService(
      entity({
        entityRef: "component:default/web",
        relations: [
          { type: "partOf", targetRef: "system:default/Growth" },
          { type: "dependsOn", targetRef: "component:default/api" },
        ],
      }),
    );
    expect(s.deps).toEqual(["component:default/api"]);
    expect(s.relations).toHaveLength(2);
  });
});

describe("scorecard engine (v2 — unknown-aware)", () => {
  it("passes owner+docs when present; unwired signals are unknown, not a penalty", () => {
    const s = service({ entityRef: "component:default/api", owner: "payments", description: "x" });
    const checks = computeChecks(s);
    expect(checks.find((c) => c.id === "owner")!.status).toBe("pass");
    expect(checks.find((c) => c.id === "docs")!.status).toBe("pass");
    expect(checks.find((c) => c.id === "slo")!.status).toBe("unknown");
    // v2: unknown checks are excluded from the denominator — 2/2 pass = 100 —
    // but only 2 known checks, so the coverage floor caps the tier at Silver.
    expect(scorecardOf(s)).toEqual({ score: 100, known: 2 });
    expect(tierOf(100, 2)).toBe("Silver");
  });

  it("reaches Gold only with the coverage floor (≥5 known checks)", () => {
    const base = service({ entityRef: "component:default/api", owner: "payments", description: "x" });
    // Doc-index + runs-feed signals wired (annotators set these): runbook,
    // tests, pipeline join owner + docs → 5 known, all pass → Gold.
    const wired = { ...base, hasDocs: true, hasRunbook: true, testsPassing: true, deploysPerWeek: 3 };
    expect(scorecardOf(wired)).toEqual({ score: 100, known: 5 });
    expect(tierOf(100, 5)).toBe("Gold");
    // A missing runbook is a REAL fail once docs are indexed: 4/5 = 80 → Silver.
    const noRunbook = { ...base, hasDocs: true, hasRunbook: false, testsPassing: true, deploysPerWeek: 3 };
    expect(scorecardOf(noRunbook)).toEqual({ score: 80, known: 5 });
  });

  it("fails owner when unowned and docs when undescribed", () => {
    const s = service({ entityRef: "component:default/x" });
    const checks = computeChecks(s);
    expect(checks.find((c) => c.id === "owner")!.status).toBe("fail");
    expect(checks.find((c) => c.id === "docs")!.status).toBe("fail");
  });

  it("resolves the owner check against a real team with distinct remediation (teams-ownership TO4)", () => {
    const owned = service({ entityRef: "component:default/a", owner: "payments" }, { ownerState: "owned", ownerTeam: { teamId: "team_p", name: "Payments", handle: "payments" } });
    const ownedChk = computeChecks(owned).find((c) => c.id === "owner")!;
    expect(ownedChk.status).toBe("pass");
    expect(ownedChk.detail).toBeUndefined();

    const unmapped = service({ entityRef: "component:default/b", owner: "legacy" }, { ownerState: "unmapped", ownerTeam: null });
    const unmappedChk = computeChecks(unmapped).find((c) => c.id === "owner")!;
    expect(unmappedChk.status).toBe("fail");
    expect(unmappedChk.detail).toMatch(/isn.t mapped/i);

    const unowned = service({ entityRef: "component:default/c" }, { ownerState: "unowned", ownerTeam: null });
    const unownedChk = computeChecks(unowned).find((c) => c.id === "owner")!;
    expect(unownedChk.status).toBe("fail");
    expect(unownedChk.detail).toMatch(/No owner declared/i);
  });

  it("uses real runtime signals when wired", () => {
    const s = service(
      { entityRef: "component:default/api", owner: "p", description: "d" },
      { slo: 99.9, sloTarget: 99.5, onCall: "Dana", hasRunbook: true, testsPassing: true, criticalVulns: 0, deploysPerWeek: 9 },
    );
    const byId = Object.fromEntries(computeChecks(s).map((c) => [c.id, c.status]));
    expect(byId).toMatchObject({ owner: "pass", docs: "pass", slo: "pass", oncall: "pass", runbook: "pass", tests: "pass", vulns: "pass", pipeline: "pass" });
    expect(scoreOf(s)).toBe(100);
    expect(tierOf(100)).toBe("Gold");
  });

  it("fails SLO when below target", () => {
    const s = service({ entityRef: "component:default/api", owner: "p" }, { slo: 97, sloTarget: 99 });
    expect(computeChecks(s).find((c) => c.id === "slo")!.status).toBe("fail");
  });

  it("does not score resources", () => {
    expect(scoreOf(service({ entityRef: "resource:default/db", kind: "Resource" }))).toBeNull();
    expect(tierOf(null)).toBeNull();
  });

  it("tiers at the documented thresholds", () => {
    expect(tierOf(85)).toBe("Gold");
    expect(tierOf(84)).toBe("Silver");
    expect(tierOf(70)).toBe("Silver");
    expect(tierOf(69)).toBe("Bronze");
  });
});

describe("needsAttention", () => {
  it("flags unowned components and unhealthy ones, never resources", () => {
    expect(needsAttention(service({ entityRef: "component:default/x" }))).toBe(true);
    expect(needsAttention(service({ entityRef: "component:default/y", owner: "p" }, { health: "down" }))).toBe(true);
    expect(needsAttention(service({ entityRef: "component:default/z", owner: "p" }, { health: "healthy" }))).toBe(false);
    expect(needsAttention(service({ entityRef: "resource:default/db", kind: "Resource" }))).toBe(false);
  });
});

describe("helpers", () => {
  it("formats deploy recency like the design", () => {
    expect(formatDeploy(null)).toBe("—");
    expect(formatDeploy(0.5)).toBe("30m ago");
    expect(formatDeploy(5)).toBe("5h ago");
    expect(formatDeploy(48)).toBe("2d ago");
  });
  it("derives owner labels and initials", () => {
    expect(ownerLabel(null)).toBe("Unowned");
    expect(ownerLabel("group:default/payments")).toBe("payments");
    expect(ownerInitials("ML Platform")).toBe("MP");
    expect(ownerInitials("payments")).toBe("PA");
    expect(ownerInitials(null)).toBe("?");
  });
  it("canonicalises lifecycle keys", () => {
    expect(lifecycleKey("production")).toBe("production");
    expect(lifecycleKey("GA")).toBe("production");
    expect(lifecycleKey("beta")).toBe("experimental");
    expect(lifecycleKey("deprecated")).toBe("deprecated");
    expect(lifecycleKey(null)).toBeNull();
    expect(lifecycleKey("weird")).toBeNull();
  });
  it("marks resources", () => {
    expect(isResource(service({ entityRef: "resource:default/db", kind: "Resource" }))).toBe(true);
    expect(isResource(service({ entityRef: "component:default/x" }))).toBe(false);
  });
});

describe("decorateService", () => {
  const services = [
    service({ entityRef: "component:default/api", owner: "payments", lifecycle: "production", description: "d" }, { lastDeployHours: 5 }),
    service({ entityRef: "component:default/web", owner: "web", relations: [{ type: "dependsOn", targetRef: "component:default/api" }] }),
    service({ entityRef: "resource:default/db", kind: "Resource" }),
  ];
  const ctx = buildContext(services);

  it("computes deps/used-by label and deploy label", () => {
    const api = decorateService(services[0]!, ctx);
    expect(api.depsLabel).toBe("0/1"); // 0 deps, used by web
    expect(api.deployLabel).toBe("5h ago");
    const web = decorateService(services[1]!, ctx);
    expect(web.depsLabel).toBe("1/0");
    expect(web.deployLabel).toBe("—");
  });

  it("renders resources as managed with no score", () => {
    const db = decorateService(services[2]!, ctx);
    expect(db.healthLabel).toBe("Managed");
    expect(db.hasScore).toBe(false);
  });
});

describe("rollup", () => {
  it("computes the index metric tiles", () => {
    const services = [
      service({ entityRef: "component:default/api", owner: "payments", system: "Checkout", description: "d" }, { slo: 99.9, sloTarget: 99, onCall: "x", hasRunbook: true, testsPassing: true, criticalVulns: 0, deploysPerWeek: 4 }),
      service({ entityRef: "component:default/lonely", system: "Growth" }),
      service({ entityRef: "resource:default/db", kind: "Resource", system: "Checkout" }),
    ];
    const r = rollup(services);
    expect(r.total).toBe(3);
    expect(r.systems).toBe(2);
    expect(r.owned).toBe(1);
    expect(r.ownedPct).toBe(33);
    expect(r.scored).toBe(2); // two components
    expect(r.ready).toBe(1); // only the gold api is ≥70
    expect(r.attention).toBe(1); // the unowned component
  });
});

describe("buildSelected", () => {
  const services = [
    service({ entityRef: "component:default/api", owner: "payments", description: "The API." }, { slo: 99.9, sloTarget: 99.5, incidents: 0, deploysPerWeek: 9 }),
    service({ entityRef: "component:default/web", relations: [{ type: "dependsOn", targetRef: "component:default/api" }] }),
  ];
  const ctx = buildContext(services);

  it("builds ops, scorecard tallies, and dependency neighborhoods", () => {
    const sel = buildSelected(services[0]!, ctx);
    expect(sel.hasOps).toBe(true);
    expect(sel.deploysWeek).toBe("9/wk");
    expect(sel.passCount + sel.warnCount + sel.failCount + sel.unknownCount).toBe(8);
    expect(sel.hasUsedBy).toBe(true);
    expect(sel.usedByList[0]!.name).toBe("web");
    expect(sel.hasDeps).toBe(false);
  });

  it("degrades ops when no runtime signal exists", () => {
    const sel = buildSelected(services[1]!, ctx);
    expect(sel.hasOps).toBe(false);
    expect(sel.deploysWeek).toBe("—");
    expect(sel.hasDeps).toBe(true);
    expect(sel.dependsOn[0]!.name).toBe("api");
  });
});
