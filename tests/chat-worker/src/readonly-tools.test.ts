// AN4 (saas-agents-native): the CI assertion that NO write-capable tool is
// reachable from the Workspace Agent's toolset (design §5.3 — read-only is
// structural, not aspirational; AN4 done-when: "CI-asserted against the tool
// manifest"). The MCP5 write set arrives in AN5, gated — never by accident.

import { allTools } from "@saas/mcp";
import { readOnlyRoster } from "@chat-worker/tools";

describe("AN4: the Workspace Agent toolset is structurally read-only", () => {
  const roster = readOnlyRoster();

  it("every reachable tool carries readOnlyHint: true", () => {
    expect(roster.length).toBeGreaterThan(0);
    for (const tool of roster) {
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it("no write-capable tool from the platform registry is reachable", () => {
    const writeTools = allTools.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name);
    expect(writeTools.length).toBeGreaterThan(0); // the MCP5 set exists…
    const reachable = new Set(roster.map((t) => t.name));
    for (const name of writeTools) {
      expect(reachable.has(name)).toBe(false); // …and none of it is reachable
    }
  });

  it("the roster is exactly the registry's read-only set (no bespoke tools)", () => {
    const expected = allTools.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name).sort();
    expect(roster.map((t) => t.name).sort()).toEqual(expected);
  });
});
