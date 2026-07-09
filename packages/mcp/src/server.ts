// Transport-agnostic MCP server assembly: every registry tool registered on a
// configured `McpServer`. Transports (CLI stdio, apps/mcp-worker) connect
// their own transport to the returned server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrunCloud } from "@saas/sdk";

import { allTools } from "./registry.js";
import { DEFAULT_LIMITS, executeTool, type ToolLimits } from "./tool.js";

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
  limits?: Partial<ToolLimits>;
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const limits: ToolLimits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const ctx = { sdk: options.sdk, limits };
  const tools = options.readOnly
    ? allTools.filter((tool) => tool.annotations.readOnlyHint === true)
    : allTools;

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args) => executeTool(tool, args, ctx),
    );
  }
  return server;
}
