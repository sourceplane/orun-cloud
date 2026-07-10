// MCP9 — manifest ⇄ wire parity (the guarantee orun's UM1 parity test
// inherits). The COMMITTED `packages/mcp/tool-manifest.json` — the exact
// bytes orun vendors — must describe the real `tools/list` a client sees:
// per-tool name/title/description/annotations verbatim and inputSchema
// semantically equal (normalized compare: JSON round-trip with keys sorted
// recursively — the manifest canonicalizes key order; JSON object key order
// carries no meaning). Freshness against the registry is vitest-guarded in
// `packages/mcp`; THIS suite pins the committed artifact to the live wire.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createMcpServer } from "@saas/mcp";

import { seededSdk } from "./fixtures.js";
import { connectRaw } from "./raw-client.js";

interface ManifestFile {
  manifestVersion: number;
  source: string;
  serverName: string;
  protocolRevision: string;
  toolCount: number;
  readOnlyToolCount: number;
  tools: Array<{
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: Record<string, unknown>;
  }>;
  resources: unknown[];
  prompts: unknown[];
}

interface WireTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const MANIFEST_PATH = fileURLToPath(
  new URL("../../../packages/mcp/tool-manifest.json", import.meta.url),
);

/** Key-order-insensitive canonical form (arrays keep their order). */
function normalize(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === "object" && v !== null) {
      const record = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = sort(record[key]);
      return sorted;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

describe("tool manifest ⇄ wire parity (MCP9)", () => {
  let manifest: ManifestFile;
  let wireTools: WireTool[];

  beforeAll(async () => {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ManifestFile;
    // The DEFAULT advertisement (no readOnly filter, no ambient workspace) —
    // the same connection shape the budget guard and conformance matrix pin.
    const { client } = await connectRaw(createMcpServer({ sdk: seededSdk() }));
    const response = await client.request("tools/list");
    await client.close();
    wireTools = response.result?.["tools"] as WireTool[];
  });

  it("names the same tools in the same order as tools/list", () => {
    expect(manifest.tools.map((t) => t.name)).toEqual(wireTools.map((t) => t.name));
    expect(manifest.toolCount).toBe(wireTools.length);
  });

  it("every manifest inputSchema equals the wire schema (normalized compare)", () => {
    const wireByName = new Map(wireTools.map((t) => [t.name, t]));
    const mismatches: string[] = [];
    for (const tool of manifest.tools) {
      const wire = wireByName.get(tool.name)!;
      if (normalize(tool.inputSchema) !== normalize(wire.inputSchema)) {
        mismatches.push(tool.name);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("title, description, and annotations match the wire verbatim", () => {
    const wireByName = new Map(wireTools.map((t) => [t.name, t]));
    for (const tool of manifest.tools) {
      const wire = wireByName.get(tool.name)!;
      expect(tool.title).toBe(wire.title);
      expect(tool.description).toBe(wire.description);
      // The wire may carry additional annotation keys in future SDK versions;
      // the manifest's three hints must each match the advertised value.
      for (const [key, value] of Object.entries(tool.annotations)) {
        expect({ tool: tool.name, key, value }).toEqual({
          tool: tool.name,
          key,
          value: wire.annotations?.[key],
        });
      }
    }
  });

  it("header counts and reserved rosters are consistent", () => {
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.source).toBe("@saas/mcp");
    expect(manifest.readOnlyToolCount).toBe(
      manifest.tools.filter((t) => t.annotations["readOnlyHint"] === true).length,
    );
    // Reserved for orun U-D2: present, minimal (2 resource templates + 4
    // prompts today — drift here means the rosters changed without a
    // manifest regeneration, which the packages/mcp freshness test also trips).
    expect(manifest.resources).toHaveLength(2);
    expect(manifest.prompts).toHaveLength(4);
  });
});
