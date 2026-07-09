// Tool-budget guard (saas-mcp-server MCP8, risk R1: tool sprawl /
// context-budget erosion). The failure mode of every MCP server is "one more
// tool" until agents drown; this suite makes the locked budget a CI fact:
// a PR that adds a 26th default tool, bloats aggregate schema size, or ships
// an unbounded/annotation-less tool fails loudly HERE.

import { allTools, createMcpServer, readOnlyTools } from "@saas/mcp";

import { seededSdk } from "./fixtures.js";
import { connectRaw } from "./raw-client.js";

/**
 * Context-cost ceiling on the aggregate WIRE-serialized input schemas of the
 * default `tools/list` (UTF-8 bytes of each tool's JSON-Schema, summed).
 *
 * Measured 2026-07-09 at 25/25 tools: 21,302 bytes (~852 bytes/tool).
 * Threshold pinned at ~1.5× that measurement — the guard catches runaway
 * growth (schema mirroring, unbounded enums, pasted-in payload schemas), not
 * normal evolution. If you trip this while adding a legitimately-shaped tool,
 * re-measure, justify, and re-pin in the same PR (design §4: a new tool must
 * displace or justify itself).
 */
const MAX_AGGREGATE_INPUT_SCHEMA_BYTES = 32_000;

/** Descriptions are model-facing context too: required, and bounded. */
const MAX_DESCRIPTION_CHARS = 500;

describe("tool budget (R1)", () => {
  it("the default roster is exactly the locked 25-tool budget — a 26th tool fails here", () => {
    // ≤ 25 is the locked budget (design §4) and 25 are registered today
    // (19 reads + 6 writes): the budget is exactly consumed. Pinned EXACTLY
    // so an added tool trips CI and must displace or justify itself.
    expect(allTools.length).toBe(25);
  });

  it("the read-only roster is exactly the 19 read tools", () => {
    expect(readOnlyTools.length).toBe(19);
    for (const tool of readOnlyTools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it("tool names are unique and <domain>_<verb>-shaped (no vendor prefix)", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("every tool description is non-empty and ≤ 500 chars", () => {
    const offenders = allTools
      .filter(
        (tool) =>
          tool.description.trim().length === 0 ||
          tool.description.length > MAX_DESCRIPTION_CHARS,
      )
      .map((tool) => `${tool.name} (${tool.description.length} chars)`);
    expect(offenders).toEqual([]);
  });

  it("every tool declares complete MCP annotations (readOnly/destructive/idempotent hints)", () => {
    const offenders = allTools
      .filter(
        (tool) =>
          typeof tool.annotations.readOnlyHint !== "boolean" ||
          typeof tool.annotations.destructiveHint !== "boolean" ||
          typeof tool.annotations.idempotentHint !== "boolean",
      )
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });

  it("aggregate wire-serialized input-schema size stays under the context-cost ceiling", async () => {
    // Measure what clients actually pay for: the JSON-Schema forms served by
    // tools/list on a DEFAULT (25-tool) connection, not the zod source.
    const { client } = await connectRaw(createMcpServer({ sdk: seededSdk() }));
    const response = await client.request("tools/list");
    await client.close();
    const tools = response.result?.["tools"] as Array<{
      name: string;
      inputSchema: unknown;
    }>;
    expect(tools).toHaveLength(25);
    let aggregateBytes = 0;
    for (const tool of tools) {
      aggregateBytes += Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8");
    }
    expect(aggregateBytes).toBeGreaterThan(0);
    if (aggregateBytes > MAX_AGGREGATE_INPUT_SCHEMA_BYTES) {
      throw new Error(
        `default tools/list input schemas serialize to ${aggregateBytes} bytes ` +
          `(ceiling ${MAX_AGGREGATE_INPUT_SCHEMA_BYTES}); trim or justify + re-pin`,
      );
    }
  });
});
