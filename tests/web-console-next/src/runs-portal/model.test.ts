import type { Run, RunJob, RunStatus, RunJobStatus } from "@saas/contracts/state";
import {
  branchOf,
  shortCommit,
  isLive,
  formatRelative,
  durationSeconds,
  formatDuration,
  decorateRun,
  splitRuns,
  buildFacets,
  applyFacet,
  summarize,
  buildRunDetail,
} from "@web-console-next/lib/runs-portal/model";
import { RUN_STATUS, JOB_STATUS, actorInitials, actorAvatar } from "@web-console-next/lib/runs-portal/palette";

const NOW = Date.parse("2026-06-29T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function run(over: Partial<Run> = {}): Run {
  return {
    runId: "01J0RUNAAAAAAAAAAAAAAAAAAA",
    orgId: "org_1",
    projectId: "prj_1",
    environment: "production",
    status: "succeeded",
    planDigest: "sha256:abc",
    source: "ci",
    git: { commit: "a1b2c3d4e5f6", ref: "refs/heads/main", dirty: false },
    createdBy: { id: "usr_1", kind: "user", displayName: "Dana Whitfield" },
    createdAt: ago(5 * MIN),
    startedAt: ago(5 * MIN - 1000),
    finishedAt: ago(5 * MIN - 159_000), // ~2m38s after start
    jobCounts: { queued: 0, running: 0, succeeded: 6, failed: 0 },
    ...over,
  };
}

function job(over: Partial<RunJob> = {}): RunJob {
  return {
    runId: "01J0RUNAAAAAAAAAAAAAAAAAAA",
    jobId: "build",
    orgId: "org_1",
    projectId: "prj_1",
    component: "checkout-api",
    deps: [],
    status: "succeeded",
    runnerId: null,
    leaseExpiresAt: null,
    attempt: 1,
    errorText: null,
    startedAt: ago(4 * MIN),
    finishedAt: ago(4 * MIN - 90_000),
    ...over,
  };
}

describe("pure helpers", () => {
  it("strips refs/heads/ from a branch ref", () => {
    expect(branchOf("refs/heads/feat/x")).toBe("feat/x");
    expect(branchOf("main")).toBe("main");
    expect(branchOf(null)).toBeNull();
    expect(branchOf("")).toBeNull();
  });

  it("shortens a commit to 7 chars", () => {
    expect(shortCommit("a1b2c3d4e5")).toBe("a1b2c3d");
    expect(shortCommit(null)).toBeNull();
  });

  it("marks running/pending as live", () => {
    expect(isLive("running")).toBe(true);
    expect(isLive("pending")).toBe(true);
    expect(isLive("succeeded")).toBe(false);
    expect(isLive("failed")).toBe(false);
    expect(isLive("canceled")).toBe(false);
  });

  it("formats relative time", () => {
    expect(formatRelative(ago(30_000), NOW)).toBe("just now");
    expect(formatRelative(ago(5 * MIN), NOW)).toBe("5m ago");
    expect(formatRelative(ago(2 * HOUR), NOW)).toBe("2h ago");
    expect(formatRelative(ago(3 * DAY), NOW)).toBe("3d ago");
    expect(formatRelative(null, NOW)).toBe("—");
  });

  it("computes and formats durations", () => {
    expect(durationSeconds(ago(160_000), ago(2000), NOW)).toBe(158);
    expect(formatDuration(158)).toBe("2m 38s");
    expect(formatDuration(20)).toBe("0m 20s");
    expect(formatDuration(3_660)).toBe("1h 01m");
    expect(formatDuration(null)).toBe("—");
    // a running job (no finishedAt) measures against `now`
    expect(durationSeconds(ago(45_000), null, NOW)).toBe(45);
    expect(durationSeconds(null, null, NOW)).toBeNull();
  });

  it("derives actor initials and avatars", () => {
    expect(actorInitials("Dana Whitfield")).toBe("DW");
    expect(actorInitials("dana")).toBe("DA");
    expect(actorInitials(null)).toBe("?");
    expect(actorAvatar({ id: "usr_1", kind: "user", displayName: "Dana Whitfield" }, "cli").bot).toBe(false);
    expect(actorAvatar({ id: "usr_1", kind: "user", displayName: "Dana" }, "ci").bot).toBe(true);
    expect(actorAvatar({ id: "wf_1", kind: "workflow", displayName: "deploy" }, "cli").bot).toBe(true);
  });
});

describe("decorateRun", () => {
  it("maps a run projection onto a row, branch as the title", () => {
    const row = decorateRun(run(), "checkout-api", NOW);
    expect(row.title).toBe("main");
    expect(row.repo).toBe("checkout-api");
    expect(row.status).toBe("succeeded");
    expect(row.vis).toBe(RUN_STATUS.succeeded);
    expect(row.live).toBe(false);
    expect(row.commit7).toBe("a1b2c3d");
    expect(row.provenance).toBe("main · a1b2c3d");
    expect(row.sourceLabel).toBe("CI");
    expect(row.duration).toBe("2m 38s");
    expect(row.rel).toBe("5m ago");
    expect(row.jobs.total).toBe(6);
    expect(row.jobs.okPct).toBe(100);
  });

  it("falls back to commit then run-id for the title", () => {
    expect(decorateRun(run({ git: { commit: "deadbeef00", ref: "", dirty: false } }), "r", NOW).title).toBe("deadbee");
    expect(
      decorateRun(run({ git: { commit: "", ref: "", dirty: false } }), "r", NOW).title,
    ).toBe("01J0RUNAAA");
  });

  it("splits live from done", () => {
    const rows = [
      decorateRun(run({ runId: "a", status: "running" }), "r", NOW),
      decorateRun(run({ runId: "b", status: "pending" }), "r", NOW),
      decorateRun(run({ runId: "c", status: "succeeded" }), "r", NOW),
    ];
    const { live, done } = splitRuns(rows);
    expect(live.map((r) => r.runId)).toEqual(["a", "b"]);
    expect(done.map((r) => r.runId)).toEqual(["c"]);
  });
});

describe("facets", () => {
  const rows = [
    decorateRun(run({ runId: "a", status: "succeeded" }), "r", NOW),
    decorateRun(run({ runId: "b", status: "failed" }), "r", NOW),
    decorateRun(run({ runId: "c", status: "running" }), "r", NOW),
    decorateRun(run({ runId: "d", status: "succeeded" }), "r", NOW),
  ];

  it("counts each status over the loaded feed", () => {
    const facets = buildFacets(rows, "all");
    const byKey = Object.fromEntries(facets.map((f) => [f.key, f.count]));
    expect(byKey.all).toBe(4);
    expect(byKey.succeeded).toBe(2);
    expect(byKey.failed).toBe(1);
    expect(byKey.running).toBe(1);
    expect(byKey.pending).toBe(0);
    expect(facets.find((f) => f.key === "succeeded")!.active).toBe(false);
    expect(buildFacets(rows, "failed").find((f) => f.key === "failed")!.active).toBe(true);
  });

  it("applies a facet", () => {
    expect(applyFacet(rows, "all")).toHaveLength(4);
    expect(applyFacet(rows, "succeeded").map((r) => r.runId)).toEqual(["a", "d"]);
  });
});

describe("summarize", () => {
  it("rolls up today / rate / running / failed / p50 over the feed", () => {
    const runs = [
      run({ runId: "a", status: "succeeded", createdAt: ago(1 * HOUR) }),
      run({ runId: "b", status: "succeeded", createdAt: ago(2 * HOUR) }),
      run({ runId: "c", status: "failed", createdAt: ago(3 * HOUR) }),
      run({ runId: "d", status: "running", createdAt: ago(10 * MIN), finishedAt: null }),
      run({ runId: "e", status: "succeeded", createdAt: ago(2 * DAY) }), // outside 24h
    ];
    const rows = runs.map((r) => decorateRun(r, "r", NOW));
    const s = summarize(rows, runs, NOW);
    expect(s.today).toBe(4); // a,b,c,d within 24h
    expect(s.running).toBe(1);
    expect(s.failed).toBe(1);
    // finished = 3 succeeded + 1 failed = 4; succeeded among ALL rows = 3 → 75%
    expect(s.rate).toBe(75);
    expect(s.p50).not.toBe("—");
    expect(s.spark).toHaveLength(14);
  });

  it("is empty-safe", () => {
    const s = summarize([], [], NOW);
    expect(s).toMatchObject({ today: 0, rate: 0, running: 0, failed: 0, p50: "—" });
    expect(s.spark).toHaveLength(14);
  });
});

describe("buildRunDetail", () => {
  const statuses: RunJobStatus[] = ["succeeded", "running", "failed", "queued"];

  it("decorates jobs and selects the first attention job by default", () => {
    const jobs = [
      job({ jobId: "setup", status: "succeeded", component: null }),
      job({ jobId: "build", status: "succeeded" }),
      job({ jobId: "deploy", status: "running", finishedAt: null }),
    ];
    const d = buildRunDetail(run({ status: "running" }), jobs, "checkout-api", NOW);
    expect(d.hero.title).toBe("main");
    expect(d.hero.repo).toBe("checkout-api");
    expect(d.jobs).toHaveLength(3);
    expect(d.jobs[0]!.name).toBe("setup"); // null component → jobId
    expect(d.jobs[1]!.name).toBe("checkout-api");
    expect(d.defaultJobId).toBe("deploy"); // first running/failed
  });

  it("defaults to the first job when none need attention", () => {
    const d = buildRunDetail(run(), [job({ jobId: "a" }), job({ jobId: "b" })], "r", NOW);
    expect(d.defaultJobId).toBe("a");
  });

  it("maps every job status to a visual", () => {
    for (const st of statuses) {
      const d = buildRunDetail(run(), [job({ status: st })], "r", NOW);
      expect(d.jobs[0]!.vis).toBe(JOB_STATUS[st]);
    }
  });

  it("has no default job when the run has none", () => {
    expect(buildRunDetail(run(), [], "r", NOW).defaultJobId).toBeNull();
  });
});

describe("status visual tables", () => {
  it("covers every run status", () => {
    const all: RunStatus[] = ["pending", "running", "succeeded", "failed", "canceled"];
    for (const s of all) expect(RUN_STATUS[s]).toBeTruthy();
  });
});
