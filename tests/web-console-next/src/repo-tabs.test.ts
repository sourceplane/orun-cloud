import { buildRepoTabs, isRepoTabActive, isRepoDetailRoute } from "@web-console-next/components/shell/repo-tabs";

describe("buildRepoTabs", () => {
  it("lists the repo settings sections in order, scoped to the project", () => {
    const tabs = buildRepoTabs("acme", "web");
    expect(tabs.map((t) => t.label)).toEqual(["Environments", "Git", "CLI", "Storage", "Config"]);
    expect(tabs.map((t) => t.href)).toEqual([
      "/orgs/acme/projects/web/environments",
      "/orgs/acme/projects/web/git",
      "/orgs/acme/projects/web/cli",
      "/orgs/acme/projects/web/storage",
      "/orgs/acme/projects/web/config",
    ]);
  });

  it("does not include a Runs tab — runs moved to the org Activities feed", () => {
    expect(buildRepoTabs("acme", "web").some((t) => /runs/i.test(t.href))).toBe(false);
  });
});

describe("isRepoTabActive", () => {
  it("keeps a tab active on its own page and its children", () => {
    const base = "/orgs/acme/projects/web/environments";
    expect(isRepoTabActive(base, base)).toBe(true);
    expect(isRepoTabActive(base, `${base}/prod`)).toBe(true);
    expect(isRepoTabActive(base, "/orgs/acme/projects/web/git")).toBe(false);
  });
});

describe("isRepoDetailRoute", () => {
  it("treats run paths as full-screen drill-ins (no tab chrome)", () => {
    expect(isRepoDetailRoute("/orgs/acme/projects/web/runs/01J0")).toBe(true);
    expect(isRepoDetailRoute("/orgs/acme/projects/web/runs")).toBe(true);
  });

  it("keeps tab chrome on the settings tabs", () => {
    expect(isRepoDetailRoute("/orgs/acme/projects/web/environments")).toBe(false);
    expect(isRepoDetailRoute("/orgs/acme/projects/web/git")).toBe(false);
    expect(isRepoDetailRoute(null)).toBe(false);
  });
});
