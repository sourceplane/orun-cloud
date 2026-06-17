import { resolveEffectiveOrgSlug } from "@web-console-next/lib/effective-org";

const org = (slug: string, createdAt: string) => ({ id: slug, slug, createdAt });

describe("resolveEffectiveOrgSlug", () => {
  it("prefers the URL's org when the route carries one", () => {
    expect(
      resolveEffectiveOrgSlug({
        urlSlug: "acme",
        lastOrgSlug: "beta",
        orgs: [org("acme", "2026-01-01T00:00:00Z"), org("beta", "2026-02-01T00:00:00Z")],
      }),
    ).toBe("acme");
  });

  it("falls back to the remembered last-used org on org-less routes", () => {
    expect(
      resolveEffectiveOrgSlug({
        urlSlug: null,
        lastOrgSlug: "beta",
        orgs: [org("acme", "2026-01-01T00:00:00Z"), org("beta", "2026-02-01T00:00:00Z")],
      }),
    ).toBe("beta");
  });

  it("trusts the remembered org before the list loads (instant chrome)", () => {
    expect(
      resolveEffectiveOrgSlug({ urlSlug: null, lastOrgSlug: "beta", orgs: null }),
    ).toBe("beta");
  });

  it("drops a remembered org that no longer resolves and uses the default", () => {
    expect(
      resolveEffectiveOrgSlug({
        urlSlug: null,
        lastOrgSlug: "ghost",
        orgs: [
          org("beta", "2026-02-01T00:00:00Z"),
          org("alpha", "2026-01-01T00:00:00Z"),
        ],
      }),
    ).toBe("alpha");
  });

  it("falls back to the account default (billing parent) when nothing is remembered", () => {
    expect(
      resolveEffectiveOrgSlug({
        urlSlug: null,
        lastOrgSlug: null,
        orgs: [
          org("beta", "2026-02-01T00:00:00Z"),
          org("alpha", "2026-01-01T00:00:00Z"),
        ],
      }),
    ).toBe("alpha");
  });

  it("returns null while the list is still loading with no hint (chrome waits)", () => {
    expect(resolveEffectiveOrgSlug({ urlSlug: null, lastOrgSlug: null, orgs: null })).toBeNull();
  });

  it("returns null for an account with no orgs (OnboardingGate takes over)", () => {
    expect(resolveEffectiveOrgSlug({ urlSlug: null, lastOrgSlug: null, orgs: [] })).toBeNull();
  });
});
