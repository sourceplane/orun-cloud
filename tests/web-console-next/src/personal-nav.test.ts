import { buildPersonalNav } from "@web-console-next/components/shell/personal-nav";

describe("buildPersonalNav", () => {
  it("is the actor-scoped area: Profile, Security activity, Sessions & devices", () => {
    const nav = buildPersonalNav();
    expect(nav.map((l) => l.key)).toEqual(["profile", "security", "sessions"]);
    expect(nav.map((l) => l.label)).toEqual(["Profile", "Security activity", "Sessions & devices"]);
  });

  it("carries no orgId — every personal route is under /account", () => {
    for (const link of buildPersonalNav()) {
      expect(link.href.startsWith("/account")).toBe(true);
    }
    expect(buildPersonalNav().map((l) => l.href)).toEqual([
      "/account",
      "/account/security",
      "/account/sessions",
    ]);
  });
});
