// MCP9 — tool-manifest export: freshness + validity.
//
// `tool-manifest.json` is a COMMITTED artifact orun vendors verbatim (UM1),
// so CI must fail the moment the registry and the file drift: the freshness
// test compares `serializeToolManifest()` against the committed bytes
// byte-for-byte (fix: `pnpm --filter @saas/mcp manifest`). The wire-equality
// guarantee (manifest inputSchema === real `tools/list` output) lives in
// `tests/mcp/src/manifest.test.ts`, next to the MCP8 conformance matrix.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MANIFEST_VERSION,
  PROTOCOL_REVISION,
  buildToolManifest,
  serializeToolManifest,
} from "../manifest.js";
import { allTools, readOnlyTools } from "../registry.js";
import { SERVER_NAME } from "../server.js";

const MANIFEST_PATH = fileURLToPath(new URL("../../tool-manifest.json", import.meta.url));

describe("tool manifest (MCP9)", () => {
  it("the committed tool-manifest.json is fresh (byte-identical to regeneration)", () => {
    const committed = readFileSync(MANIFEST_PATH, "utf8");
    expect(committed).toBe(serializeToolManifest());
  });

  it("serialization is deterministic (two builds serialize identically)", () => {
    expect(serializeToolManifest(buildToolManifest())).toBe(
      serializeToolManifest(buildToolManifest()),
    );
  });

  it("canonical form: sorted keys, 2-space indent, trailing newline", () => {
    const serialized = serializeToolManifest();
    expect(serialized.endsWith("}\n")).toBe(true);
    expect(serialized.startsWith('{\n  "')).toBe(true);
    // Sorted keys at every level: re-parsing and re-serializing via the same
    // canonicalizer is a fixpoint; spot-check top-level order directly too.
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    const firstTool = (parsed["tools"] as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(firstTool)).toEqual([...Object.keys(firstTool)].sort());
  });

  it("header fields pin the contract identity", () => {
    const manifest = buildToolManifest();
    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION);
    expect(manifest.source).toBe("@saas/mcp");
    expect(manifest.serverName).toBe(SERVER_NAME);
    expect(manifest.protocolRevision).toBe(PROTOCOL_REVISION);
  });

  it("tools mirror the registry: names, registry order, counts", () => {
    const manifest = buildToolManifest();
    expect(manifest.tools.map((t) => t.name)).toEqual(allTools.map((t) => t.name));
    expect(manifest.toolCount).toBe(allTools.length);
    expect(manifest.readOnlyToolCount).toBe(readOnlyTools.length);
    expect(
      manifest.tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name),
    ).toEqual(readOnlyTools.map((t) => t.name));
  });

  it("every tool entry carries title, description, and complete annotations", () => {
    for (const tool of buildToolManifest().tools) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations.idempotentHint).toBe("boolean");
    }
  });

  it("every inputSchema is a JSON-Schema object covering the zod shape", () => {
    const manifest = buildToolManifest();
    for (const [index, tool] of manifest.tools.entries()) {
      const source = allTools[index]!;
      const schema = tool.inputSchema;
      expect(schema["type"]).toBe("object");
      const properties = (schema["properties"] ?? {}) as Record<string, unknown>;
      const shapeKeys = Object.keys(source.inputSchema.shape);
      // Every zod field surfaces as a JSON-Schema property (and no phantom
      // wire fields exist that the runtime validator would reject).
      expect(Object.keys(properties).sort()).toEqual([...shapeKeys].sort());
      // Non-optional zod fields must be `required` on the wire.
      const required = (schema["required"] ?? []) as string[];
      const mandatory = shapeKeys.filter((key) => !source.inputSchema.shape[key]!.isOptional());
      expect([...required].sort()).toEqual(mandatory.sort());
    }
  });

  it("resources/prompts stubs are present and minimally complete (orun U-D2)", () => {
    const manifest = buildToolManifest();
    expect(manifest.resources.length).toBeGreaterThan(0);
    for (const resource of manifest.resources) {
      expect(resource.name.length).toBeGreaterThan(0);
      expect(resource.description.length).toBeGreaterThan(0);
      expect(resource.uriTemplate).toMatch(/^[a-z]+:\/\//);
    }
    expect(manifest.prompts.length).toBeGreaterThan(0);
    for (const prompt of manifest.prompts) {
      expect(prompt.name.length).toBeGreaterThan(0);
      expect(prompt.description.length).toBeGreaterThan(0);
      for (const arg of prompt.args) {
        expect(arg.name.length).toBeGreaterThan(0);
        expect(typeof arg.required).toBe("boolean");
      }
    }
  });
});
