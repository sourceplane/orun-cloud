// Tool-manifest export (saas-mcp-server MCP9, unification phase D7).
//
// `packages/mcp` is the CONTRACT SOURCE OF TRUTH for the platform tool plane
// (README decision 9): the orun Go binary reimplements these tools natively
// and vendors `tool-manifest.json` VERBATIM as its parity fixture (orun UM1,
// drift risk U-R1). The manifest therefore captures the exact wire surface —
// for every registry tool, the JSON-Schema input a client sees on
// `tools/list` — not the zod source.
//
// Wire fidelity: the MCP SDK's `tools/list` handler converts each registered
// zod schema via `toJsonSchemaCompat(schema, { strictUnions: true,
// pipeStrategy: "input" })` (see `server/mcp.js` in
// `@modelcontextprotocol/sdk`; for zod v3 that delegates to the SDK's pinned
// `zod-to-json-schema`). We import and call THAT function with THOSE options,
// so the manifest's `inputSchema` is semantically identical to the wire form
// — guaranteed by a `tests/mcp` conformance test comparing the committed file
// against a real `tools/list` over `InMemoryTransport`.
//
// Determinism (so diffs are meaningful and regeneration is byte-stable):
//   - object keys sorted recursively (arrays keep their order),
//   - tools in registry order (`allTools`), resources/prompts in roster order,
//   - 2-space indent, trailing newline.
// The committed artifact `packages/mcp/tool-manifest.json` is freshness-tested
// (regenerating must produce a byte-identical file).
//
// Note: the manifest describes the DEFAULT advertisement — no ambient
// `defaultWorkspace` (which would relax `workspace` to optional on the wire,
// a per-connection transport concern; see `server.ts`).

import {
  getSchemaDescription,
  isSchemaOptional,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

import { allPrompts } from "./prompts.js";
import { allTools, readOnlyTools } from "./registry.js";
import { allResources } from "./resources.js";
import { SERVER_NAME } from "./server.js";

/** Bump on manifest SHAPE changes (consumers pin it — orun UM1). */
export const MANIFEST_VERSION = 1;

/** The pinned MCP spec revision this server implements (risk D6). */
export const PROTOCOL_REVISION = "2025-06-18";

export interface ManifestToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

export interface ManifestTool {
  name: string;
  title: string;
  description: string;
  /** The exact wire JSON Schema clients see on `tools/list`. */
  inputSchema: Record<string, unknown>;
  annotations: ManifestToolAnnotations;
}

/** Reserved stub (orun U-D2 consumes later): resource templates, minimal. */
export interface ManifestResource {
  name: string;
  title: string;
  description: string;
  uriTemplate: string;
}

/** Reserved stub (orun U-D2): prompt roster with wire-shaped arguments. */
export interface ManifestPrompt {
  name: string;
  title: string;
  description: string;
  args: Array<{ name: string; description?: string; required: boolean }>;
}

export interface ToolManifest {
  manifestVersion: number;
  source: string;
  serverName: string;
  protocolRevision: string;
  toolCount: number;
  readOnlyToolCount: number;
  tools: ManifestTool[];
  resources: ManifestResource[];
  prompts: ManifestPrompt[];
}

/**
 * Convert one registry tool's zod input schema to its wire JSON-Schema form —
 * the SAME converter + options the SDK's `tools/list` handler applies.
 */
export function toWireInputSchema(
  schema: Parameters<typeof toJsonSchemaCompat>[0],
): Record<string, unknown> {
  return toJsonSchemaCompat(schema, {
    strictUnions: true,
    pipeStrategy: "input",
  });
}

/** Build the manifest object from the live registry/rosters. */
export function buildToolManifest(): ToolManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    source: "@saas/mcp",
    serverName: SERVER_NAME,
    protocolRevision: PROTOCOL_REVISION,
    toolCount: allTools.length,
    readOnlyToolCount: readOnlyTools.length,
    tools: allTools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toWireInputSchema(tool.inputSchema),
      annotations: {
        readOnlyHint: tool.annotations.readOnlyHint,
        // The registry requires all three hints (budget guard); the fallbacks
        // are the MCP spec defaults and exist only to satisfy the optional
        // types — they are dead code for every registered tool.
        destructiveHint: tool.annotations.destructiveHint ?? true,
        idempotentHint: tool.annotations.idempotentHint ?? false,
      },
    })),
    resources: allResources.map((resource) => ({
      name: resource.name,
      title: resource.metadata.title,
      description: resource.metadata.description,
      uriTemplate: resource.template.uriTemplate.toString(),
    })),
    prompts: allPrompts.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      // Mirrors the SDK's `promptArgumentsFromSchema` (prompts/list wire
      // shape): name + description + required, via the SDK's own helpers.
      args: Object.entries(prompt.argsSchema).map(([name, field]) => {
        const description = getSchemaDescription(field);
        return {
          name,
          ...(description !== undefined ? { description } : {}),
          required: !isSchemaOptional(field),
        };
      }),
    })),
  };
}

/** Recursively sort object keys; arrays keep their order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The canonical serialized manifest: sorted keys, 2-space indent, trailing
 * newline. `tool-manifest.json` is exactly this string — the freshness test
 * compares byte-for-byte, and orun vendors the file without transformation.
 */
export function serializeToolManifest(manifest: ToolManifest = buildToolManifest()): string {
  return `${JSON.stringify(sortKeysDeep(manifest), null, 2)}\n`;
}
