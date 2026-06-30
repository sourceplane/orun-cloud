import { buildNavSections, isLinkActive } from "@web-console-next/components/shell/nav-items";

describe("buildNavSections", () => {
  it("does not render Workspace/Account nav sections (org switcher + account chip own those)", () => {
    const ids = buildNavSections({ orgSlug: "acme" }).map((s) => s.id);
    expect(ids).not.toContain("workspace");
    expect(ids).not.toContain("account");
    const allHrefs = buildNavSections({ orgSlug: "acme" }).flatMap((s) => s.links.map((l) => l.href));
    expect(allHrefs).not.toContain("/orgs"); // Organizations link removed
    expect(allHrefs).not.toContain("/account");
    expect(allHrefs).not.toContain("/account/security");
  });

  it("flags the Settings link as a sub-panel (renderer shows a chevron)", () => {
    const manage = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org-manage")!;
    const settings = manage.links.find((l) => l.href === "/orgs/acme/settings")!;
    expect(settings.subPanel).toBe(true);
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const projects = org.links.find((l) => l.href === "/orgs/acme/projects")!;
    expect(projects.subPanel ?? false).toBe(false);
  });

  it("returns no sections when there is no org scope", () => {
    expect(buildNavSections({})).toHaveLength(0);
  });

  it("omits org/project sections without slugs", () => {
    const ids = buildNavSections({}).map((s) => s.id);
    expect(ids).not.toContain("org");
    expect(ids).not.toContain("project");
  });

  it("adds a product-focused org section (work surfaces only) at the top", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const hrefs = org.links.map((l) => l.href);
    expect(hrefs).toContain("/orgs/acme/projects");
    expect(hrefs).toContain("/orgs/acme/catalog");
    expect(hrefs).toContain("/orgs/acme/activities");
    // Integrations is a first-class connections hub in the product nav.
    expect(hrefs).toContain("/orgs/acme/integrations");
    expect(org.footer ?? false).toBe(false);
    expect(org.label).toBe("Workspace · acme");
    // The "manage" surfaces moved to the pinned footer group, not this section.
    expect(hrefs).not.toContain("/orgs/acme/usage");
    expect(hrefs).not.toContain("/orgs/acme/settings");
  });

  it("pins Usage & Settings to a footer group (bottom of the rail)", () => {
    const sections = buildNavSections({ orgSlug: "acme" });
    const manage = sections.find((s) => s.id === "org-manage")!;
    expect(manage.footer).toBe(true);
    const hrefs = manage.links.map((l) => l.href);
    expect(hrefs).toEqual(["/orgs/acme/usage", "/orgs/acme/settings"]);
    // It is ordered after the product section so it renders below it.
    expect(sections.findIndex((s) => s.id === "org-manage")).toBeGreaterThan(
      sections.findIndex((s) => s.id === "org"),
    );
  });

  it("surfaces Activities as an always-available org-level run feed (like Catalog)", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const activities = org.links.find((l) => l.href === "/orgs/acme/activities")!;
    expect(activities).toBeDefined();
    expect(activities.label).toBe("Activities");
    // It is a top-level surface, not a sub-panel.
    expect(activities.subPanel ?? false).toBe(false);
  });

  it("keeps org administration out of the primary sidebar (moved under Settings)", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const hrefs = org.links.map((l) => l.href);
    // These now live behind the dedicated Settings surface.
    expect(hrefs).not.toContain("/orgs/acme/members");
    expect(hrefs).not.toContain("/orgs/acme/billing");
    expect(hrefs).not.toContain("/orgs/acme/webhooks");
  });

  it("keeps the Settings link active across nested settings pages", () => {
    expect(isLinkActive("/orgs/acme/settings", "/orgs/acme/settings")).toBe(true);
    expect(isLinkActive("/orgs/acme/settings", "/orgs/acme/settings/webhooks")).toBe(true);
    expect(isLinkActive("/orgs/acme/settings", "/orgs/acme/settings/members")).toBe(true);
  });

  it("no longer renders a per-repo sidebar section — repo settings live in tabs", () => {
    // Selecting a repo opens a settings-style page whose sections (Environments,
    // Git, CLI, Storage, Config) are horizontal tabs, not a sidebar section.
    expect(buildNavSections({ orgSlug: "acme", projectSlug: "web" }).find((s) => s.id === "project")).toBeUndefined();
    const allHrefs = buildNavSections({ orgSlug: "acme", projectSlug: "web" }).flatMap((s) =>
      s.links.map((l) => l.href),
    );
    expect(allHrefs).not.toContain("/orgs/acme/projects/web/runs");
    expect(allHrefs).not.toContain("/orgs/acme/projects/web/git");
  });
});

describe("isLinkActive", () => {
  it("matches /orgs only exactly (not nested org pages)", () => {
    expect(isLinkActive("/orgs", "/orgs")).toBe(true);
    expect(isLinkActive("/orgs", "/orgs/acme/projects")).toBe(false);
  });

  it("matches /account exactly so it does not swallow /account/security", () => {
    expect(isLinkActive("/account", "/account")).toBe(true);
    expect(isLinkActive("/account", "/account/security")).toBe(false);
    expect(isLinkActive("/account/security", "/account/security")).toBe(true);
  });

  it("matches a link when the path is the href or a child of it", () => {
    expect(isLinkActive("/orgs/acme/usage", "/orgs/acme/usage")).toBe(true);
    expect(isLinkActive("/orgs/acme/webhooks", "/orgs/acme/webhooks/ep_123")).toBe(true);
  });

  it("does not match sibling prefixes", () => {
    expect(isLinkActive("/orgs/acme/api-keys", "/orgs/acme/api-keys-archive")).toBe(false);
  });

  it("returns false for a null pathname", () => {
    expect(isLinkActive("/orgs", null)).toBe(false);
  });
});
