// access_explain / usage_summary / quota_check / billing_summary

import { describe, expect, it, vi } from "vitest";

import { dataOf, errorDetailOf, forbidden, runTool, textOf } from "./helpers.js";

describe("access_explain", () => {
  const permissions = [
    { action: "project.read", allow: true, reason: "role", via: { kind: "team", teamId: "team_1" } },
    { action: "project.delete", allow: false, reason: "denied" },
  ];
  const members = [{ id: "mem_1", subjectId: "usr_1", roles: [] }];
  const teams = [{ id: "team_1", name: "Payments", slug: "payments" }];

  it("combines effective access with the member and team rosters", async () => {
    const effectiveAccess = vi.fn().mockResolvedValue({ permissions });
    const listMembers = vi.fn().mockResolvedValue({ members });
    const listTeams = vi.fn().mockResolvedValue({ teams });
    const result = await runTool(
      "access_explain",
      { workspace: "ws_1", project: "prj_a", subjectId: "usr_1" },
      { teams: { effectiveAccess, listTeams }, memberships: { listMembers } },
    );
    expect(effectiveAccess).toHaveBeenCalledWith("ws_1", {
      projectId: "prj_a",
      subjectId: "usr_1",
    });
    expect(listMembers).toHaveBeenCalledWith("ws_1");
    expect(listTeams).toHaveBeenCalledWith("ws_1");
    expect(textOf(result)).toContain("1/2 action(s) allowed");
    expect(dataOf(result)).toEqual({ permissions, members, teams });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "access_explain",
      { workspace: "ws_1" },
      {
        teams: {
          effectiveAccess: vi.fn().mockResolvedValue({ permissions: [] }),
          listTeams: vi.fn().mockResolvedValue({ teams: [] }),
        },
        memberships: { listMembers: vi.fn().mockRejectedValue(forbidden()) },
      },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("usage_summary", () => {
  const summary = { metric: "api.request", totalQuantity: 42, totalRecords: 3, rollups: [] };

  it("maps project/environment inputs onto the metering query", async () => {
    const getUsageSummary = vi.fn().mockResolvedValue(summary);
    const result = await runTool(
      "usage_summary",
      {
        workspace: "ws_1",
        metric: "api.request",
        project: "prj_a",
        bucketType: "day",
        startTime: "2026-01-01T00:00:00Z",
      },
      { metering: { getUsageSummary } },
    );
    expect(getUsageSummary).toHaveBeenCalledWith("ws_1", {
      metric: "api.request",
      projectId: "prj_a",
      bucketType: "day",
      startTime: "2026-01-01T00:00:00Z",
    });
    expect(dataOf(result)).toEqual(summary);
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "usage_summary",
      { workspace: "ws_1", metric: "api.request" },
      { metering: { getUsageSummary: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("quota_check", () => {
  const check = {
    allowed: false,
    metric: "runs",
    limit: 100,
    used: 120,
    remaining: 0,
    period: "month",
    enforcement: "hard",
    reason: "quota_exceeded",
  };

  it("checks one metric's quota", async () => {
    const checkQuota = vi.fn().mockResolvedValue(check);
    const result = await runTool(
      "quota_check",
      { workspace: "ws_1", metric: "runs", project: "prj_a" },
      { metering: { checkQuota } },
    );
    expect(checkQuota).toHaveBeenCalledWith("ws_1", { metric: "runs", projectId: "prj_a" });
    expect(textOf(result)).toContain("over quota");
    expect(dataOf(result)).toEqual(check);
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "quota_check",
      { workspace: "ws_1", metric: "runs" },
      { metering: { checkQuota: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("billing_summary", () => {
  const summary = { customer: null, activeSubscription: null, plan: { name: "Pro" }, entitlements: [] };
  const entitlements = [{ id: "ent_1", entitlementKey: "feature.mcp_server", enabled: true }];

  it("combines the billing summary with the entitlement list", async () => {
    const getSummary = vi.fn().mockResolvedValue(summary);
    const getEntitlements = vi.fn().mockResolvedValue({ entitlements });
    const result = await runTool(
      "billing_summary",
      { workspace: "ws_1" },
      { billing: { getSummary, getEntitlements } },
    );
    expect(getSummary).toHaveBeenCalledWith("ws_1");
    expect(getEntitlements).toHaveBeenCalledWith("ws_1");
    expect(textOf(result)).toContain("Pro");
    expect(dataOf(result)).toEqual({ summary, entitlements });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "billing_summary",
      { workspace: "ws_1" },
      {
        billing: {
          getSummary: vi.fn().mockRejectedValue(forbidden()),
          getEntitlements: vi.fn().mockResolvedValue({ entitlements: [] }),
        },
      },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});
