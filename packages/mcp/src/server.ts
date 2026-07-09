// Transport-agnostic MCP server assembly: every registry tool, resource
// template, and prompt registered on a configured `McpServer`. Transports
// (CLI stdio, apps/mcp-worker) connect their own transport to the returned
// server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrunCloud } from "@saas/sdk";

import { toErrorResult, toResourceReadError } from "./errors.js";
import { allPrompts } from "./prompts.js";
import { allTools, readOnlyTools } from "./registry.js";
import { allResources } from "./resources.js";
import {
  DEFAULT_LIMITS,
  executeTool,
  type McpTool,
  type ToolCallGate,
  type ToolLimits,
} from "./tool.js";
import type { McpUsageOptions } from "./usage.js";

export const SERVER_NAME = "orun-cloud";
// Bumped with the package; also the marker for the implemented MCP spec
// revision (2025-06-18 via @modelcontextprotocol/sdk ^1.29 — risk D6).
export const SERVER_VERSION = "0.1.0";

/**
 * Provenance marker (design §7): every SDK call made from the MCP plane —
 * read AND write — carries `x-client-surface: mcp`, so audit queries can
 * segment agent traffic. Authorization semantics are unchanged by it.
 */
export const CLIENT_SURFACE_HEADER = "x-client-surface";
export const CLIENT_SURFACE_VALUE = "mcp";

export interface CreateMcpServerOptions {
  /**
   * The platform client every tool call rides. `createMcpServer` stamps
   * `x-client-surface: mcp` into this client's transport default headers
   * (provenance, design §7) — pass a dedicated instance per server, as both
   * shipped transports do.
   */
  sdk: OrunCloud;
  /**
   * Hard-exclude the MCP5 write tools from `tools/list`, not just execution
   * (design §7): a read-only connection advertises and serves exactly the
   * 19 read tools.
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
  /**
   * MCP6 metering (design §8): when set with `enabled: true`, every
   * SUCCESSFUL tool call fire-and-forgets one `mcp.tool_call` usage event
   * through the public metering ingest on the caller's credential. Default
   * off — unit tests and roster listings stay silent. Transports opt in:
   * CLI `mcp serve` with `transport: "stdio"`, the worker with `"http"`.
   */
  usage?: McpUsageOptions;
  /**
   * MCP6 entitlement gate (design §8): a transport-supplied pre-call check
   * run before every tool call (see `createEntitlementGate`). A gate throw
   * maps through the standard tool-error mapper, so a denied workspace gets
   * the platform's `entitlement_required` upgrade-shaped error. The gate is
   * a TRANSPORT concern by design — the tool plane knows nothing of billing.
   */
  gate?: ToolCallGate;
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
  // Provenance (design §7): stamp the surface marker into the SDK transport's
  // default headers so EVERY call this server makes — reads, writes, resource
  // reads — carries it. The transport merges default headers first, so auth /
  // per-request headers are unaffected. Guarded because tests may pass a bare
  // stub in place of a full `OrunCloud`.
  const defaultHeaders = options.sdk.transport?.defaultHeaders;
  if (defaultHeaders !== undefined) {
    defaultHeaders[CLIENT_SURFACE_HEADER] = CLIENT_SURFACE_VALUE;
  }

  const limits: ToolLimits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const ctx = { sdk: options.sdk, limits };
  const tools = options.readOnly ? readOnlyTools : allTools;

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
      async (args) => {
        const input = applyWorkspaceDefault(tool, args, options.defaultWorkspace);
        if (options.gate !== undefined) {
          try {
            await options.gate(tool, input);
          } catch (err) {
            // Gate denials ride the SAME error mapping as handler errors —
            // agents see the platform code (e.g. `entitlement_required`).
            return toErrorResult(err);
          }
        }
        return executeTool(tool, input, ctx, options.usage);
      },
    );
  }

  // MCP4 resources + prompts are read-only context/templates by construction,
  // so `readOnly` never filters them. Prompts reference tool names in text
  // only — a read-only connection with the full read toolset resolves every
  // reference (drift-guarded in tests).
  for (const resource of allResources) {
    server.registerResource(
      resource.name,
      resource.template,
      resource.metadata,
      async (uri, variables) => {
        try {
          return await resource.read(uri, variables, ctx);
        } catch (err) {
          // Resource reads have no isError channel; surface the platform
          // error code in the protocol error's message (design §4 semantics).
          throw toResourceReadError(err);
        }
      },
    );
  }
  for (const prompt of allPrompts) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: prompt.argsSchema,
      },
      (args) => ({
        description: prompt.description,
        messages: [
          { role: "user", content: { type: "text", text: prompt.build(args) } },
        ],
      }),
    );
  }
  return server;
}
