import { teamInitials, teamAvatarColor } from "@web-console-next/lib/teams/avatar";

describe("team avatar (teams-platform)", () => {
  it("derives two-letter initials from a name", () => {
    expect(teamInitials("Platform Engineering")).toBe("PE");
    expect(teamInitials("payments")).toBe("PA");
    expect(teamInitials("ML")).toBe("ML");
    expect(teamInitials("   ")).toBe("?");
  });

  it("is deterministic per seed and stable across renames", () => {
    const a = teamAvatarColor("payments");
    const b = teamAvatarColor("payments");
    expect(a).toEqual(b); // same seed → same colour (survives a name change)
    expect(a.bg).toMatch(/^hsl\(/);
    expect(a.fg).toMatch(/^hsl\(/);
  });

  it("spreads different seeds across hues", () => {
    const seeds = ["payments", "search", "growth", "platform", "checkout", "identity"];
    const hues = new Set(seeds.map((s) => teamAvatarColor(s).fg));
    expect(hues.size).toBeGreaterThan(1);
  });
});
