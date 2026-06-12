import { defaultOrgDestination } from "@web-console-next/lib/last-org";

describe("defaultOrgDestination", () => {
  it("routes to the last-used org's projects when one is remembered", () => {
    expect(defaultOrgDestination("acme")).toBe("/orgs/acme/projects");
  });

  it("falls back to the org picker when none is remembered", () => {
    expect(defaultOrgDestination(null)).toBe("/orgs");
  });
});
