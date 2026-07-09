// runs_list / runs_get / runs_read_logs

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LIMITS } from "../registry.js";

import { dataOf, errorDetailOf, forbidden, runTool, textOf } from "./helpers.js";

const run = {
  runId: "01RUN",
  orgId: "org_1",
  projectId: "prj_a",
  environment: "prod",
  status: "failed",
  planDigest: "sha256:plan",
  source: "ci",
  git: { commit: "abc", ref: "refs/heads/main", dirty: false },
  createdBy: { id: "usr_1", kind: "user" },
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  jobCounts: { queued: 0, running: 0, succeeded: 1, failed: 1 },
};

const job = {
  runId: "01RUN",
  jobId: "build",
  orgId: "org_1",
  projectId: "prj_a",
  component: "api",
  deps: [],
  status: "failed",
  runnerId: null,
  leaseExpiresAt: null,
  attempt: 1,
  errorText: "exit 1",
  startedAt: null,
  finishedAt: null,
};

describe("runs_list", () => {
  it("uses the org-global feed when no project is given", async () => {
    const listOrgRuns = vi.fn().mockResolvedValue({
      runs: [run],
      nextCursor: { createdAt: "2026-01-02T00:00:00Z", id: "run_2" },
    });
    const listRuns = vi.fn();
    const result = await runTool(
      "runs_list",
      { workspace: "ws_1", status: "failed", cursor: "a|b", limit: 5 },
      { state: { listOrgRuns, listRuns } },
    );
    expect(listRuns).not.toHaveBeenCalled();
    expect(listOrgRuns).toHaveBeenCalledWith("ws_1", {
      status: "failed",
      cursor: "a|b",
      limit: 5,
    });
    expect(dataOf(result)).toEqual({
      runs: [run],
      meta: { cursor: "2026-01-02T00:00:00Z|run_2" },
    });
  });

  it("uses the project-scoped list when project is given", async () => {
    const listRuns = vi.fn().mockResolvedValue({ runs: [run], nextCursor: null });
    const result = await runTool(
      "runs_list",
      { workspace: "ws_1", project: "prj_a", environment: "prod" },
      { state: { listRuns, listOrgRuns: vi.fn() } },
    );
    expect(listRuns).toHaveBeenCalledWith("ws_1", "prj_a", { environment: "prod" });
    expect(dataOf(result)["meta"]).toEqual({ cursor: null });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "runs_list",
      { workspace: "ws_1" },
      { state: { listOrgRuns: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("runs_get", () => {
  it("combines the run projection with its plan-DAG jobs", async () => {
    const getRun = vi.fn().mockResolvedValue({ run });
    const listRunJobs = vi.fn().mockResolvedValue({ jobs: [job] });
    const result = await runTool(
      "runs_get",
      { workspace: "ws_1", project: "prj_a", runId: "01RUN" },
      { state: { getRun, listRunJobs } },
    );
    expect(getRun).toHaveBeenCalledWith("ws_1", "prj_a", "01RUN");
    expect(listRunJobs).toHaveBeenCalledWith("ws_1", "prj_a", "01RUN");
    expect(textOf(result)).toContain("failed");
    expect(dataOf(result)).toEqual({ run, jobs: [job] });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "runs_get",
      { workspace: "ws_1", project: "prj_a", runId: "01RUN" },
      {
        state: {
          getRun: vi.fn().mockRejectedValue(forbidden()),
          listRunJobs: vi.fn().mockResolvedValue({ jobs: [] }),
        },
      },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("runs_read_logs", () => {
  it("passes fromSeq through and returns the tail cursor", async () => {
    const readRunJobLogs = vi
      .fn()
      .mockResolvedValue({ content: "line1\nline2", nextSeq: 7, complete: true });
    const result = await runTool(
      "runs_read_logs",
      { workspace: "ws_1", project: "prj_a", runId: "01RUN", jobId: "build", fromSeq: 3 },
      { state: { readRunJobLogs } },
    );
    expect(readRunJobLogs).toHaveBeenCalledWith("ws_1", "prj_a", "01RUN", "build", 3);
    expect(dataOf(result)).toEqual({
      content: "line1\nline2",
      truncated: false,
      truncatedBytes: 0,
      nextSeq: 7,
      complete: true,
    });
  });

  it("defaults fromSeq to 0 and byte-caps oversized logs", async () => {
    const readRunJobLogs = vi
      .fn()
      .mockResolvedValue({ content: "y".repeat(50), nextSeq: 1, complete: false });
    const result = await runTool(
      "runs_read_logs",
      { workspace: "ws_1", project: "prj_a", runId: "01RUN", jobId: "build" },
      { state: { readRunJobLogs } },
      { ...DEFAULT_LIMITS, maxTextBytes: 10 },
    );
    expect(readRunJobLogs).toHaveBeenCalledWith("ws_1", "prj_a", "01RUN", "build", 0);
    const data = dataOf(result);
    expect(data["truncated"]).toBe(true);
    expect(String(data["content"])).toContain("use fromSeq/cursor");
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "runs_read_logs",
      { workspace: "ws_1", project: "prj_a", runId: "01RUN", jobId: "build" },
      { state: { readRunJobLogs: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});
