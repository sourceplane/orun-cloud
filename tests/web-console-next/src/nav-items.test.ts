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

  it("puts Overview first in the org section, pointing at the org root", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const first = org.links[0]!;
    expect(first.label).toBe("Overview");
    expect(first.href).toBe("/orgs/acme");
    expect(first.subPanel ?? false).toBe(false);
  });

  it("adds a product-focused org section (work surfaces only) at the top", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const hrefs = org.links.map((l) => l.href);
    expect(hrefs).toContain("/orgs/acme");
    expect(hrefs).toContain("/orgs/acme/projects");
    expect(hrefs).toContain("/orgs/acme/catalog");
    expect(hrefs).toContain("/orgs/acme/activities");
    expect(hrefs).toContain("/orgs/acme/work");
    // Integrations is a first-class connections hub in the product nav.
    expect(hrefs).toContain("/orgs/acme/integrations");
    // Secrets & Config is a dedicated top-level product surface.
    expect(hrefs).toContain("/orgs/acme/secrets");
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

  it("promotes Secrets & Config to a top-level product surface with the KeyRound icon", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const secrets = org.links.find((l) => l.href === "/orgs/acme/secrets")!;
    expect(secrets).toBeDefined();
    expect(secrets.label).toBe("Secrets");
    expect(secrets.icon).toBe("KeyRound");
    // It is a plain surface link, not a sub-panel, and sits after Integrations.
    expect(secrets.subPanel ?? false).toBe(false);
    const hrefs = org.links.map((l) => l.href);
    expect(hrefs.indexOf("/orgs/acme/secrets")).toBeGreaterThan(
      hrefs.indexOf("/orgs/acme/integrations"),
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

  it("matches /you exactly so it does not swallow /you/security (SI5: personal area renamed from /account)", () => {
    expect(isLinkActive("/you", "/you")).toBe(true);
    expect(isLinkActive("/you", "/you/security")).toBe(false);
    expect(isLinkActive("/you/security", "/you/security")).toBe(true);
  });

  it("matches the org root (Overview) exactly, not its sub-routes", () => {
    // The Overview home row lives at /orgs/:slug, a prefix of every org page —
    // it must only light up on the root, never on Catalog/Activities/etc.
    expect(isLinkActive("/orgs/acme", "/orgs/acme")).toBe(true);
    expect(isLinkActive("/orgs/acme", "/orgs/acme/catalog")).toBe(false);
    expect(isLinkActive("/orgs/acme", "/orgs/acme/projects/web/environments")).toBe(false);
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
