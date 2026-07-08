import { buildAccountNav, isAccountSettingsPath } from "@web-console-next/components/shell/account-nav";

describe("buildAccountNav", () => {
  it("is a single Account group with Overview, Workspaces, Members, Roles, Billing", () => {
    const groups = buildAccountNav("acme");
    expect(groups.map((g) => g.id)).toEqual(["account"]);
    const account = groups.find((g) => g.id === "account")!;
    expect(account.links.map((l) => l.label)).toEqual([
      "Overview",
      "Workspaces",
      "Members",
      "Roles",
      "Billing & plan",
    ]);
  });

  it("keeps the account pages at their existing /settings/account/* and /settings/billing URLs (relabel, not remodel)", () => {
    const hrefs = buildAccountNav("acme").find((g) => g.id === "account")!.links.map((l) => l.href);
    expect(hrefs).toEqual([
      "/orgs/acme/settings/account",
      "/orgs/acme/settings/account/workspaces",
      "/orgs/acme/settings/account/members",
      "/orgs/acme/settings/account/roles",
      "/orgs/acme/settings/billing",
    ]);
  });

  it("marks Overview as the exact-match doorway index", () => {
    const overview = buildAccountNav("acme").find((g) => g.id === "account")!.links.find((l) => l.label === "Overview")!;
    expect(overview.href).toBe("/orgs/acme/settings/account");
    expect(overview.exact).toBe(true);
  });
});

describe("isAccountSettingsPath", () => {
  it("is true on the account pages and the account-billed billing page", () => {
    expect(isAccountSettingsPath("/orgs/acme/settings/account")).toBe(true);
    expect(isAccountSettingsPath("/orgs/acme/settings/account/members")).toBe(true);
    expect(isAccountSettingsPath("/orgs/acme/settings/billing")).toBe(true);
    expect(isAccountSettingsPath("/orgs/acme/settings/billing/change-plan")).toBe(true);
  });

  it("is false on workspace settings and a null pathname", () => {
    expect(isAccountSettingsPath("/orgs/acme/settings")).toBe(false);
    expect(isAccountSettingsPath("/orgs/acme/settings/members")).toBe(false);
    expect(isAccountSettingsPath("/orgs/acme/settings/webhooks")).toBe(false);
    expect(isAccountSettingsPath(null)).toBe(false);
  });

  it("does not match a sibling prefix like /settings/accounting", () => {
    expect(isAccountSettingsPath("/orgs/acme/settings/accounting")).toBe(false);
  });
});
