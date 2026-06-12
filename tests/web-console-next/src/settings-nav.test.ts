import {
  buildSettingsNav,
  flattenSettingsNav,
  isSettingsLinkActive,
} from "@web-console-next/components/shell/settings-nav";

describe("buildSettingsNav", () => {
  it("groups settings into Organization, Billing, and Developer", () => {
    const ids = buildSettingsNav("acme").map((g) => g.id);
    expect(ids).toEqual(["organization", "billing", "developer"]);
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
        "/orgs/acme/settings/members",
        "/orgs/acme/settings/invitations",
        "/orgs/acme/settings/billing",
        "/orgs/acme/settings/api-keys",
        "/orgs/acme/settings/webhooks",
        "/orgs/acme/settings/config",
        "/orgs/acme/settings/audit",
      ]),
    );
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
