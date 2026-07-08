import { buildPersonalNav } from "@web-console-next/components/shell/personal-nav";

describe("buildPersonalNav", () => {
  it("is the actor-scoped area: Profile, Security activity, Sessions & devices", () => {
    const nav = buildPersonalNav();
    expect(nav.map((l) => l.key)).toEqual(["profile", "security", "sessions"]);
    expect(nav.map((l) => l.label)).toEqual(["Profile", "Security activity", "Sessions & devices"]);
  });

  it("carries no orgId — every personal route is under /you (SI5: renamed from /account)", () => {
    for (const link of buildPersonalNav()) {
      expect(link.href.startsWith("/you")).toBe(true);
    }
    expect(buildPersonalNav().map((l) => l.href)).toEqual([
      "/you",
      "/you/security",
      "/you/sessions",
    ]);
  });
});
