import {
  docDigestOf,
  environmentCount,
  healthyPct,
  overviewActivity,
  primaryRepoFacet,
  repoFromEntityRef,
  resolveOverviewState,
  shortSha,
  tierCounts,
  topAttention,
} from "@web-console-next/lib/overview/model";
import type { RepoFacet } from "@saas/contracts/state";
import type { CatalogService } from "@web-console-next/lib/catalog-portal/model";
import type { RunRow } from "@web-console-next/lib/runs-portal/model";
import type { RunStatus } from "@saas/contracts/state";

// ── fixtures ─────────────────────────────────────────────────

function svc(over: Partial<CatalogService> = {}): CatalogService {
  return {
    key: over.key ?? Math.random().toString(36).slice(2),
    name: "svc",
    entityRef: "component:default/svc",
    ref: "component:default/svc",
    kind: "Component",
    sourceProjectId: "prj_1",
    sourceEnvironment: "dev",
    sourceCommit: null,
    system: "core",
    owner: "group:team",
    language: null,
    lifecycle: null,
    description: "a service",
    deps: [],
    relations: [],
    ...over,
  };
}

/** A component with every readiness signal satisfied → score 100 → Gold. */
function gold(over: Partial<CatalogService> = {}): CatalogService {
  return svc({
    owner: "group:team",
    description: "documented",
    onCall: "oncall",
    slo: 99.9,
    sloTarget: 99,
    hasRunbook: true,
    testsPassing: true,
    criticalVulns: 0,
    deploysPerWeek: 3,
    ...over,
  });
}

/** owner + docs only, everything else unknown → score 63 → Bronze. */
function bronze(over: Partial<CatalogService> = {}): CatalogService {
  return svc({ owner: "group:team", description: "documented", ...over });
}

function row(status: RunStatus, createdMs: number): RunRow {
  return { status, createdMs } as unknown as RunRow;
}

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── resolveOverviewState ─────────────────────────────────────

describe("resolveOverviewState", () => {
  it("is no-repo when nothing is linked", () => {
    expect(resolveOverviewState({ repoCount: 0, catalogCount: 0 })).toBe("no-repo");
    expect(resolveOverviewState({ repoCount: 0, catalogCount: 5 })).toBe("no-repo");
  });
  it("is no-plan when a repo is linked but the catalog is empty", () => {
    expect(resolveOverviewState({ repoCount: 1, catalogCount: 0 })).toBe("no-plan");
  });
  it("is ready when repos and catalog are both present", () => {
    expect(resolveOverviewState({ repoCount: 2, catalogCount: 12 })).toBe("ready");
  });
});

// ── overviewActivity ─────────────────────────────────────────

describe("overviewActivity", () => {
  const rows: RunRow[] = [
    row("succeeded", NOW - HOUR), // newest first
    row("failed", NOW - 2 * HOUR),
    row("running", NOW - 3 * HOUR),
    row("succeeded", NOW - 8 * DAY), // outside the 7-day window
  ];

  it("counts only runs within the last 7 days", () => {
    expect(overviewActivity(rows, NOW).last7d).toBe(3);
  });
  it("computes success rate over finished runs in the window", () => {
    // window finished = 1 succeeded + 1 failed → 50%
    expect(overviewActivity(rows, NOW).successRate).toBe(50);
  });
  it("counts running over the whole loaded feed and takes the newest status", () => {
    const a = overviewActivity(rows, NOW);
    expect(a.running).toBe(1);
    expect(a.lastStatus).toBe("succeeded");
  });
  it("degrades cleanly with no runs", () => {
    expect(overviewActivity([], NOW)).toEqual({ last7d: 0, successRate: 0, running: 0, lastStatus: null });
  });
});

// ── tierCounts ───────────────────────────────────────────────

describe("tierCounts", () => {
  it("partitions scored services by tier and excludes resources", () => {
    // v2: bronze()'s two passing known checks score 100 but the Gold coverage
    // floor (≥5 known) caps it at Silver — low coverage is capped, not punished.
    const services = [gold(), bronze(), svc({ kind: "Resource", owner: null })];
    const t = tierCounts(services);
    expect(t.gold).toBe(1);
    expect(t.silver).toBe(1);
    expect(t.scored).toBe(2); // the resource is not scored
    expect(t.gold + t.silver + t.bronze).toBe(t.scored);
  });
  it("is all-zero for an empty catalog", () => {
    expect(tierCounts([])).toEqual({ gold: 0, silver: 0, bronze: 0, scored: 0 });
  });
});

// ── topAttention ─────────────────────────────────────────────

describe("topAttention", () => {
  const unowned = svc({ key: "a", owner: null });
  const healthy = svc({ key: "b", owner: "group:team", health: "healthy" });
  const down = svc({ key: "c", owner: "group:team", health: "down" });

  it("returns services that are unowned or unhealthy, in order", () => {
    expect(topAttention([unowned, healthy, down], 5).map((s) => s.key)).toEqual(["a", "c"]);
  });
  it("caps the result at n", () => {
    expect(topAttention([unowned, down], 1).map((s) => s.key)).toEqual(["a"]);
  });
});

// ── small helpers ────────────────────────────────────────────

// ── repo facet helpers (WO5) ─────────────────────────────────

function facet(over: Partial<RepoFacet> = {}): RepoFacet {
  return {
    orgId: "org_1",
    projectId: "prj_1",
    displayName: null,
    description: null,
    owner: null,
    defaultBranch: null,
    links: [],
    tags: [],
    docRef: null,
    entityRef: null,
    headDigest: "sha256:aaa",
    sourceCommit: null,
    syncedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

describe("repo facet helpers", () => {
  it("primaryRepoFacet takes the first (most-recently-synced) facet", () => {
    expect(primaryRepoFacet([])).toBeNull();
    const a = facet({ projectId: "prj_a" });
    const b = facet({ projectId: "prj_b" });
    expect(primaryRepoFacet([a, b])?.projectId).toBe("prj_a");
  });
  it("docDigestOf reads docRef.digest, else null", () => {
    expect(docDigestOf(null)).toBeNull();
    expect(docDigestOf(facet())).toBeNull();
    expect(docDigestOf(facet({ docRef: { path: "docs/overview.md" } }))).toBeNull();
    expect(docDigestOf(facet({ docRef: { digest: "sha256:d" } }))).toBe("sha256:d");
  });
  it("repoFromEntityRef extracts the middle segment", () => {
    expect(repoFromEntityRef("default/orun/orun")).toBe("orun");
    expect(repoFromEntityRef("ns/repo/name")).toBe("repo");
    expect(repoFromEntityRef("two/seg")).toBeNull();
    expect(repoFromEntityRef(null)).toBeNull();
  });
  it("shortSha truncates to 7", () => {
    expect(shortSha("a1b2c3d4e5")).toBe("a1b2c3d");
    expect(shortSha(null)).toBeNull();
  });
});

describe("healthyPct / environmentCount", () => {
  it("healthyPct is the inverse of the attention rate", () => {
    expect(healthyPct(10, 2)).toBe(80);
    expect(healthyPct(0, 0)).toBe(0);
  });
  it("environmentCount counts distinct non-null source environments", () => {
    const services = [
      svc({ sourceEnvironment: "dev" }),
      svc({ sourceEnvironment: "prod" }),
      svc({ sourceEnvironment: "dev" }),
      svc({ sourceEnvironment: null }),
    ];
    expect(environmentCount(services)).toBe(2);
  });
});
