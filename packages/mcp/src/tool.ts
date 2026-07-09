// Tool-plane core types + `defineTool` (saas-mcp-server MCP0, design §2/§4).
//
// A tool handler receives exactly `{ sdk, limits }` — the client-not-service
// invariant enforced by the type: handlers can reach the platform only through
// `@saas/sdk` calls carrying the caller's credential, never a service binding.

import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { OrunCloud } from "@saas/sdk";
import type { z } from "zod";

import { toErrorResult } from "./errors.js";
import { DEFAULT_MAX_TEXT_BYTES } from "./truncate.js";
import { emitToolCallUsage, type McpUsageOptions } from "./usage.js";

/** Output-size caps applied by handlers that return logs/doc bodies. */
export interface ToolLimits {
  /** Byte cap on a single text payload (log tail, doc body). */
  maxTextBytes: number;
}

export const DEFAULT_LIMITS: ToolLimits = {
  maxTextBytes: DEFAULT_MAX_TEXT_BYTES,
};

/** Everything a tool handler may touch. Nothing else is provided by design. */
export interface ToolContext {
  sdk: OrunCloud;
  limits: ToolLimits;
}

/**
 * What a handler returns: structured JSON mirroring the public DTOs (so agents
 * can chain calls) plus a one-line human/model-readable summary (design §4
 * "Output shape").
 */
export interface ToolResult {
  summary: string;
  data: unknown;
}

/** MCP tool annotations this package requires on every tool (design §7). */
export interface McpToolAnnotations extends ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

/** A registered tool with the input type erased for homogeneous rosters. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations: McpToolAnnotations;
  /** Parses `input` against `inputSchema` before invoking the typed handler. */
  handler: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<Shape>;
  annotations: McpToolAnnotations;
  handler: (
    input: z.output<z.ZodObject<Shape>>,
    ctx: ToolContext,
  ) => Promise<ToolResult>;
}): McpTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema as unknown as z.ZodObject<z.ZodRawShape>,
    annotations: def.annotations,
    handler: (input, ctx) => def.handler(def.inputSchema.parse(input), ctx),
  };
}

/**
 * A transport-supplied pre-call check (MCP6: the entitlement gate). Runs
 * before the handler; throwing (e.g. `EntitlementDeniedError`) short-circuits
 * the call into the standard tool-error mapping. The gate lives at the
 * transport seam by design — nothing in the tool plane knows about billing.
 */
export type ToolCallGate = (tool: McpTool, input: unknown) => Promise<void>;

/**
 * Run a tool and adapt its `ToolResult` into MCP content: a text block of
 * `summary + "\n" + JSON.stringify(data)`, with `structuredContent` set when
 * `data` is an object. SDK/unexpected errors become `isError` results carrying
 * the platform error code — this function never throws (design §4 "Error
 * mapping").
 *
 * When a transport opted into usage emission (MCP6), each SUCCESSFUL call
 * fire-and-forgets one `mcp.tool_call` usage event — never awaited, never
 * fails the call (see `usage.ts`). Failed calls emit nothing.
 */
export async function executeTool(
  tool: McpTool,
  input: unknown,
  ctx: ToolContext,
  usage?: McpUsageOptions,
): Promise<CallToolResult> {
  try {
    const { summary, data } = await tool.handler(input, ctx);
    if (usage !== undefined) emitToolCallUsage(ctx.sdk, tool, input, usage);
    const result: CallToolResult = {
      content: [{ type: "text", text: `${summary}\n${JSON.stringify(data)}` }],
    };
    if (isPlainObject(data)) {
      result.structuredContent = data;
    }
    return result;
  } catch (err) {
    return toErrorResult(err);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
