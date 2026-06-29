import { effectiveIntegrationOrg } from "@saas/db/membership";

describe("effectiveIntegrationOrg", () => {
  it("returns the org's own id when standalone (parentOrgId null)", () => {
    expect(effectiveIntegrationOrg({ id: "org_standalone", parentOrgId: null })).toBe(
      "org_standalone",
    );
  });

  it("returns the parent's id when the org is a child workspace", () => {
    expect(
      effectiveIntegrationOrg({ id: "org_workspace", parentOrgId: "org_account" }),
    ).toBe("org_account");
  });

  it("treats every standalone org as its own integration tenant (back-compat)", () => {
    // The IT1 invariant: with no parent set (every existing org), resolution
    // collapses to the org id, so all current integration behavior is preserved
    // and the seam stays dormant until a customer owns a parent account.
    for (const id of ["org_a", "org_b", "org_c"]) {
      expect(effectiveIntegrationOrg({ id, parentOrgId: null })).toBe(id);
    }
  });

  it("resolves siblings under one account to the same owning org", () => {
    // Two workspaces under one account both resolve UP to the account org —
    // the credential lives once at the account, shared by every workspace.
    const account = "org_account";
    expect(effectiveIntegrationOrg({ id: "org_ws_a", parentOrgId: account })).toBe(account);
    expect(effectiveIntegrationOrg({ id: "org_ws_b", parentOrgId: account })).toBe(account);
  });

  it("matches effectiveBillingOrgId's shape (twin seam, identical rule)", () => {
    // Documents the deliberate twinning with billing-scope: same parentOrgId
    // resolution, so integrations mirror billing's lazy, additive discipline.
    const cases = [
      { id: "x", parentOrgId: null, expected: "x" },
      { id: "y", parentOrgId: "p", expected: "p" },
    ];
    for (const c of cases) {
      expect(effectiveIntegrationOrg({ id: c.id, parentOrgId: c.parentOrgId })).toBe(c.expected);
    }
  });
});
