import { buildPeopleTabs, resolvePeopleTab } from "@web-console-next/components/people/people-tabs";

describe("buildPeopleTabs", () => {
  it("is Members, Pending, Roles, Access with Members as the bare default surface", () => {
    const tabs = buildPeopleTabs("acme");
    expect(tabs.map((t) => t.key)).toEqual(["members", "pending", "roles", "access"]);
    expect(tabs.map((t) => t.label)).toEqual(["Members", "Pending", "Roles", "Access"]);
    expect(tabs.find((t) => t.key === "members")!.href).toBe("/orgs/acme/settings/people");
    expect(tabs.find((t) => t.key === "pending")!.href).toBe("/orgs/acme/settings/people?tab=pending");
    expect(tabs.find((t) => t.key === "roles")!.href).toBe("/orgs/acme/settings/people?tab=roles");
    expect(tabs.find((t) => t.key === "access")!.href).toBe("/orgs/acme/settings/people?tab=access");
  });
});

describe("resolvePeopleTab", () => {
  it("resolves valid tabs and defaults everything else to Members", () => {
    expect(resolvePeopleTab("pending")).toBe("pending");
    expect(resolvePeopleTab("roles")).toBe("roles");
    expect(resolvePeopleTab("access")).toBe("access");
    expect(resolvePeopleTab("members")).toBe("members");
    expect(resolvePeopleTab(null)).toBe("members");
    expect(resolvePeopleTab(undefined)).toBe("members");
    expect(resolvePeopleTab("bogus")).toBe("members");
  });
});
