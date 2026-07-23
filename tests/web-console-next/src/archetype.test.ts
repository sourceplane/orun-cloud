// IR1: archetype.ts shrank to the one consumer left — connection-detail's
// body branching. The hub's grouping moved to the registry helpers
// (integration-registry-helpers.test.ts); this map dies with IR2 when the
// connection detail is absorbed into the provider space.

import { archetypeForProvider } from "@web-console-next/components/integrations/archetype";

describe("archetypeForProvider (connection-detail branching)", () => {
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
});
