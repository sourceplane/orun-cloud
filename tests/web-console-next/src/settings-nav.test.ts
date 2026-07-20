import {
  buildSettingsNav,
  flattenSettingsNav,
  isSettingsLinkActive,
} from "@web-console-next/components/shell/settings-nav";

describe("buildSettingsNav", () => {
  it("is workspace-scoped only — Workspace, Event routing, Developer (SI2: Account promoted to its own doorway)", () => {
    const ids = buildSettingsNav("acme").map((g) => g.id);
    expect(ids).toEqual(["organization", "notifications", "developer"]);
  });

  it("no longer renders the Account group inline — it moved to the Account doorway (SI2)", () => {
    expect(buildSettingsNav("acme").some((g) => g.id === "account")).toBe(false);
    // Account-scoped links (Billing bills at the account) leave the workspace rail.
    const hrefs = flattenSettingsNav(buildSettingsNav("acme")).map((l) => l.href);
    expect(hrefs).not.toContain("/orgs/acme/settings/billing");
    expect(hrefs).not.toContain("/orgs/acme/settings/account");
  });

  it("relabels the event-routing group to disambiguate it from personal Email notifications (SI1)", () => {
    const routing = buildSettingsNav("acme").find((g) => g.id === "notifications")!;
    expect(routing.label).toBe("Event routing");
    const personal = flattenSettingsNav(buildSettingsNav("acme")).find(
      (l) => l.href === "/orgs/acme/settings/notifications",
    )!;
    expect(personal.label).toBe("Email notifications");
  });

  it("no longer lists Sessions & devices — CLI sessions are per-user, moved to the account area (SI1)", () => {
    const hrefs = flattenSettingsNav(buildSettingsNav("acme")).map((l) => l.href);
    expect(hrefs).not.toContain("/orgs/acme/settings/cli-sessions");
  });

  it("exposes the event-routing surfaces under the Event routing group", () => {
    const hrefs = flattenSettingsNav(buildSettingsNav("acme")).map((l) => l.href);
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/orgs/acme/settings/notifications/rules",
        "/orgs/acme/settings/notifications/channels",
        "/orgs/acme/settings/notifications/dead-letters",
      ]),
    );
  });

  it("roots every link under the org settings base", () => {
    for (const link of flattenSettingsNav(buildSettingsNav("acme"))) {
      expect(link.href.startsWith("/orgs/acme/settings")).toBe(true);
    }
  });

  it("exposes General as the exact-match settings index", () => {
    const general = flattenSettingsNav(buildSettingsNav("acme")).find((l) => l.label === "General")!;
    expect(general.href).toBe("/orgs/acme/settings");
    expect(general.exact).toBe(true);
  });

  it("includes the migrated administration surfaces", () => {
    const hrefs = flattenSettingsNav(buildSettingsNav("acme")).map((l) => l.href);
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/orgs/acme/settings/api-keys",
        "/orgs/acme/settings/webhooks",
        "/orgs/acme/settings/audit",
      ]),
    );
  });

  it("consolidates Members, Invitations, and Access into one People & Access link (SI3)", () => {
    const hrefs = flattenSettingsNav(buildSettingsNav("acme")).map((l) => l.href);
    expect(hrefs).toContain("/orgs/acme/settings/people");
    // The three former standalone links are gone from the rail.
    expect(hrefs).not.toContain("/orgs/acme/settings/members");
    expect(hrefs).not.toContain("/orgs/acme/settings/invitations");
    expect(hrefs).not.toContain("/orgs/acme/settings/access");
  });

  it("lists the MCP server (Connect an agent, saas-mcp-server MCP7) under Developer, next to API keys", () => {
    const developer = buildSettingsNav("acme").find((g) => g.id === "developer")!;
    const hrefs = developer.links.map((l) => l.href);
    expect(hrefs).toContain("/orgs/acme/settings/mcp");
    // Adjacent to API keys — the credential an agent key rides is minted there.
    expect(hrefs.indexOf("/orgs/acme/settings/mcp")).toBe(
      hrefs.indexOf("/orgs/acme/settings/api-keys") + 1,
    );
    const mcp = developer.links.find((l) => l.href === "/orgs/acme/settings/mcp")!;
    expect(mcp.label).toBe("MCP server");
  });

  it("no longer lists Integrations — promoted to the top-level connections hub", () => {
    const hrefs = flattenSettingsNav(buildSettingsNav("acme")).map((l) => l.href);
    expect(hrefs).not.toContain("/orgs/acme/settings/integrations");
  });

  it("no longer lists Config under Developer — promoted to the top-level Secrets surface", () => {
    const hrefs = flattenSettingsNav(buildSettingsNav("acme")).map((l) => l.href);
    expect(hrefs).not.toContain("/orgs/acme/settings/config");
    // The Developer group survives (api keys, webhooks, audit remain).
    const developer = buildSettingsNav("acme").find((g) => g.id === "developer")!;
    expect(developer.links.length).toBeGreaterThan(0);
  });
});

describe("isSettingsLinkActive", () => {
  const links = flattenSettingsNav(buildSettingsNav("acme"));
  const general = links.find((l) => l.label === "General")!;
  const webhooks = links.find((l) => l.label === "Webhooks")!;

  it("matches General only on the exact settings index", () => {
    expect(isSettingsLinkActive(general, "/orgs/acme/settings")).toBe(true);
    expect(isSettingsLinkActive(general, "/orgs/acme/settings/members")).toBe(false);
  });

  it("keeps a section active on its nested detail pages", () => {
    expect(isSettingsLinkActive(webhooks, "/orgs/acme/settings/webhooks")).toBe(true);
    expect(isSettingsLinkActive(webhooks, "/orgs/acme/settings/webhooks/ep_123")).toBe(true);
  });

  it("does not match sibling prefixes or a null pathname", () => {
    expect(isSettingsLinkActive(webhooks, "/orgs/acme/settings/webhooks-archive")).toBe(false);
    expect(isSettingsLinkActive(webhooks, null)).toBe(false);
  });
});

describe("AI providers door (saas-dispatch DX6)", () => {
  it("lists AI providers under Developer, beside the MCP server", () => {
    const developer = buildSettingsNav("acme").find((g) => g.id === "developer")!;
    const hrefs = developer.links.map((l) => l.href);
    expect(hrefs).toContain("/orgs/acme/settings/ai-providers");
    const entry = developer.links.find((l) => l.href === "/orgs/acme/settings/ai-providers")!;
    expect(entry.label).toBe("AI providers");
    expect(entry.description).toContain("OpenRouter");
  });
});
