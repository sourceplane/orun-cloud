import { buildBreadcrumbs } from "@web-console-next/components/shell/breadcrumbs";

const org = { orgSlug: "acme", orgName: "Acme Inc" };

describe("buildBreadcrumbs", () => {
  it("starts with the org name linking to its Overview home", () => {
    const crumbs = buildBreadcrumbs({ ...org, pathname: "/orgs/acme/usage" });
    expect(crumbs[0]).toEqual({ label: "Acme Inc", href: "/orgs/acme" });
  });

  it("labels the top-level Teams surface", () => {
    const crumbs = buildBreadcrumbs({ ...org, pathname: "/orgs/acme/teams" });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme" },
      { label: "Teams" },
    ]);
  });

  it("renders the org page itself as a single unlinked crumb", () => {
    expect(buildBreadcrumbs({ ...org, pathname: "/orgs/acme" })).toEqual([{ label: "Acme Inc" }]);
  });

  it("labels known segments and leaves the last crumb unlinked", () => {
    const crumbs = buildBreadcrumbs({ ...org, pathname: "/orgs/acme/settings/members" });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme" },
      { label: "Settings", href: "/orgs/acme/settings" },
      { label: "Members" },
    ]);
  });

  it("labels the top-level Secrets & Config surface", () => {
    const crumbs = buildBreadcrumbs({ ...org, pathname: "/orgs/acme/secrets" });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme" },
      { label: "Secrets & Config" },
    ]);
  });

  it("labels the org-global catalog index", () => {
    const crumbs = buildBreadcrumbs({ ...org, pathname: "/orgs/acme/catalog" });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme" },
      { label: "Catalog" },
    ]);
  });

  it("links a project crumb onward to its environments list", () => {
    const crumbs = buildBreadcrumbs({
      ...org,
      pathname: "/orgs/acme/projects/demo-app/environments",
    });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme" },
      { label: "Git Repos", href: "/orgs/acme/projects" },
      { label: "demo-app", href: "/orgs/acme/projects/demo-app/environments" },
      { label: "Environments" },
    ]);
  });

  it("renders environment detail with the env slug as the current page", () => {
    const crumbs = buildBreadcrumbs({
      ...org,
      pathname: "/orgs/acme/projects/demo-app/environments/prod",
    });
    expect(crumbs[crumbs.length - 1]).toEqual({ label: "prod" });
  });

  it("renders nested billing pages with every ancestor linked", () => {
    const crumbs = buildBreadcrumbs({
      ...org,
      pathname: "/orgs/acme/settings/billing/change-plan",
    });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme" },
      { label: "Settings", href: "/orgs/acme/settings" },
      { label: "Billing & plan", href: "/orgs/acme/settings/billing" },
      { label: "Change plan" },
    ]);
  });

  it("leaves an unknown dynamic segment unlinked when not last", () => {
    const crumbs = buildBreadcrumbs({
      ...org,
      pathname: "/orgs/acme/settings/webhooks/ep_123",
    });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme" },
      { label: "Settings", href: "/orgs/acme/settings" },
      { label: "Webhooks", href: "/orgs/acme/settings/webhooks" },
      { label: "ep_123" },
    ]);
  });

  it("falls back to an unlinked org crumb on a foreign pathname", () => {
    expect(buildBreadcrumbs({ ...org, pathname: "/account" })).toEqual([{ label: "Acme Inc" }]);
    expect(buildBreadcrumbs({ ...org, pathname: null })).toEqual([{ label: "Acme Inc" }]);
  });
});
