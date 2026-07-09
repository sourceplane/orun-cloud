// whoami / workspaces_list / projects_list

import { describe, expect, it, vi } from "vitest";

import { dataOf, errorDetailOf, forbidden, runTool, textOf } from "./helpers.js";

const org = { id: "org_1", name: "Acme", slug: "acme", workspaceRef: "ws_1", createdAt: "2026-01-01T00:00:00Z" };
const user = { id: "usr_1", email: "dev@acme.test", displayName: "Dev" };
const projectA = { id: "prj_a", orgId: "org_1", name: "API", slug: "api", status: "active", createdAt: "", updatedAt: "", archivedAt: null };
const projectB = { id: "prj_b", orgId: "org_1", name: "Web", slug: "web", status: "active", createdAt: "", updatedAt: "", archivedAt: null };
const env = { id: "env_1", orgId: "org_1", projectId: "prj_a", name: "prod", slug: "prod", status: "active" };

describe("whoami", () => {
  it("combines the auth profile with the workspace list", async () => {
    const getProfile = vi.fn().mockResolvedValue({ user });
    const list = vi.fn().mockResolvedValue({ organizations: [org] });
    const result = await runTool("whoami", {}, { auth: { getProfile }, workspaces: { list } });
    expect(getProfile).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain("dev@acme.test");
    expect(dataOf(result)).toEqual({ user, workspaces: [org] });
  });

  it("maps a forbidden SDK error to an isError result preserving the code", async () => {
    const result = await runTool(
      "whoami",
      {},
      {
        auth: { getProfile: vi.fn().mockRejectedValue(forbidden()) },
        workspaces: { list: vi.fn().mockResolvedValue({ organizations: [] }) },
      },
    );
    expect(result.isError).toBe(true);
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("workspaces_list", () => {
  it("lists workspaces", async () => {
    const list = vi.fn().mockResolvedValue({ organizations: [org] });
    const result = await runTool("workspaces_list", {}, { workspaces: { list } });
    expect(dataOf(result)).toEqual({ workspaces: [org] });
  });

  it("maps forbidden", async () => {
    const result = await runTool("workspaces_list", {}, {
      workspaces: { list: vi.fn().mockRejectedValue(forbidden()) },
    });
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("projects_list", () => {
  it("lists projects without environments when no filter is given", async () => {
    const list = vi.fn().mockResolvedValue({ projects: [projectA, projectB] });
    const envList = vi.fn();
    const result = await runTool(
      "projects_list",
      { workspace: "acme" },
      { repos: { list }, environments: { list: envList } },
    );
    expect(list).toHaveBeenCalledWith("acme");
    expect(envList).not.toHaveBeenCalled();
    expect(dataOf(result)).toEqual({ projects: [projectA, projectB] });
  });

  it("inlines environments for a single project filter (id or slug)", async () => {
    const list = vi.fn().mockResolvedValue({ projects: [projectA, projectB] });
    const envList = vi.fn().mockResolvedValue({ environments: [env] });
    const result = await runTool(
      "projects_list",
      { workspace: "ws_1", project: "api" },
      { repos: { list }, environments: { list: envList } },
    );
    expect(envList).toHaveBeenCalledWith("ws_1", "prj_a");
    expect(dataOf(result)).toEqual({ projects: [projectA], environments: [env] });
  });

  it("returns an empty result (not an error) for an unknown project filter", async () => {
    const list = vi.fn().mockResolvedValue({ projects: [projectA] });
    const result = await runTool(
      "projects_list",
      { workspace: "ws_1", project: "ghost" },
      { repos: { list }, environments: { list: vi.fn() } },
    );
    expect(result.isError).toBeUndefined();
    expect(dataOf(result)).toEqual({ projects: [], environments: [] });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "projects_list",
      { workspace: "acme" },
      { repos: { list: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});
