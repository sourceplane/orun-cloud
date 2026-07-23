import {
  ARCHETYPE_LABELS,
  ARCHETYPE_ORDER,
  archetypeForProvider,
  groupByArchetype,
  type Archetype,
} from "@web-console-next/components/integrations/archetype";

describe("archetype grouping (design §6)", () => {
  it("orders archetypes: source control, messaging, infrastructure", () => {
    expect(ARCHETYPE_ORDER).toEqual(["source-control", "messaging", "infrastructure"]);
  });

  it("labels every archetype", () => {
    expect(ARCHETYPE_LABELS).toEqual({
      "source-control": "Source control",
      messaging: "Messaging",
      infrastructure: "Infrastructure",
    });
  });

  it("maps provider ids to archetypes, null for unknown ids", () => {
    expect(archetypeForProvider("github")).toBe("source-control");
    expect(archetypeForProvider("slack")).toBe("messaging");
    expect(archetypeForProvider("discord")).toBe("messaging");
    expect(archetypeForProvider("cloudflare")).toBe("infrastructure");
    expect(archetypeForProvider("supabase")).toBe("infrastructure");
    expect(archetypeForProvider("aws")).toBe("infrastructure");
    expect(archetypeForProvider("gitlab")).toBeNull();
    expect(archetypeForProvider("")).toBeNull();
  });

  it("groups items in archetype order, labeled, dropping empty archetypes", () => {
    const items: Array<{ id: string; archetype: Archetype }> = [
      { id: "cloudflare", archetype: "infrastructure" },
      { id: "github", archetype: "source-control" },
      { id: "supabase", archetype: "infrastructure" },
    ];
    const groups = groupByArchetype(items);
    expect(groups.map((g) => g.archetype)).toEqual(["source-control", "infrastructure"]);
    expect(groups.map((g) => g.label)).toEqual(["Source control", "Infrastructure"]);
    // Input order preserved within a group.
    expect(groups[1]!.items.map((i) => i.id)).toEqual(["cloudflare", "supabase"]);
  });

  it("returns no groups for no items", () => {
    expect(groupByArchetype([])).toEqual([]);
  });
});
