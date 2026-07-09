// Transport-agnostic MCP server assembly: every registry tool registered on a
// configured `McpServer`. Transports (CLI stdio, apps/mcp-worker) connect
// their own transport to the returned server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrunCloud } from "@saas/sdk";

import { allTools } from "./registry.js";
import { DEFAULT_LIMITS, executeTool, type McpTool, type ToolLimits } from "./tool.js";

export const SERVER_NAME = "orun-cloud";
// Bumped with the package; also the marker for the implemented MCP spec
// revision (2025-06-18 via @modelcontextprotocol/sdk ^1.29 — risk D6).
export const SERVER_VERSION = "0.1.0";

export interface CreateMcpServerOptions {
  sdk: OrunCloud;
  /**
   * Hard-exclude non-read-only tools from `tools/list`, not just execution
   * (design §7). All MCP0 tools are read-only, so this is a no-op today; the
   * flag plumbs through for the MCP5 write set.
   */
  readOnly?: boolean;
  /**
   * Ambient `workspace` default for transports that carry CLI context
   * (design §3: the stdio server may default `workspace` from the CLI's
   * active context). Filled into a call's input only when the tool's schema
   * declares a `workspace` field and the caller omitted it — explicit input
   * always wins, and tools without a `workspace` argument are untouched.
   */
  defaultWorkspace?: string;
  limits?: Partial<ToolLimits>;
}

/**
 * Apply the transport's ambient `workspace` default to a tool call's input.
 * Pass-through when there is no default, the tool's schema has no `workspace`
 * field, or the caller supplied an explicit value.
 */
export function applyWorkspaceDefault(
  tool: McpTool,
  input: unknown,
  defaultWorkspace: string | undefined,
): unknown {
  if (defaultWorkspace === undefined) return input;
  if (!("workspace" in tool.inputSchema.shape)) return input;
  const record =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (record["workspace"] !== undefined) return input;
  return { ...record, workspace: defaultWorkspace };
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const limits: ToolLimits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const ctx = { sdk: options.sdk, limits };
  const tools = options.readOnly
    ? allTools.filter((tool) => tool.annotations.readOnlyHint === true)
    : allTools;

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of tools) {
    // With an ambient default the advertised schema makes `workspace`
    // optional on the wire (a server-side value fills the gap); `executeTool`
    // still validates the filled input against the tool's own schema.
    const workspaceField = tool.inputSchema.shape["workspace"];
    const inputSchema =
      options.defaultWorkspace !== undefined && workspaceField !== undefined
        ? tool.inputSchema.extend({ workspace: workspaceField.optional() })
        : tool.inputSchema;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema,
        annotations: tool.annotations,
      },
      (args) =>
        executeTool(
          tool,
          applyWorkspaceDefault(tool, args, options.defaultWorkspace),
          ctx,
        ),
    );
  }
  return server;
}
