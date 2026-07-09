// MCP6 metering (design §8): each successful tool call emits one
// `mcp.tool_call` usage event through the STANDARD public metering ingestion
// (`POST /v1/organizations/{org}/usage` via the SDK metering client) carrying
// the caller's own credential — the platform meters itself the way it meters
// customers (client-not-service, design §2). No service bindings, no direct
// metering-worker access, no contract changes: tool name and transport ride
// the ingest contract's existing bounded `metadata` field.
//
// FIRE-AND-FORGET by contract: the ingest is never awaited on the tool-call
// path and its failure is swallowed (with an optional debug note) — a
// metering outage must never block or fail agent traffic.

import type { OrunCloud } from "@saas/sdk";

import type { McpTool } from "./tool.js";

/** The metric key for MCP tool-call usage events (design §8). */
export const MCP_TOOL_CALL_METRIC = "mcp.tool_call";

/**
 * Usage-emission options a transport passes to `createMcpServer`. Default is
 * OFF (no `usage` option → no events): unit tests, `mcp tools`, and embedded
 * uses stay silent unless a transport deliberately opts in.
 */
export interface McpUsageOptions {
  /** Master switch. `false` behaves exactly like omitting the option. */
  enabled: boolean;
  /** Which transport is serving — an event dimension (design §8). */
  transport: "stdio" | "http";
  /**
   * Scheduler for the detached ingest promise. The worker passes
   * `ctx.waitUntil` so the event outlives the response; the CLI omits it (a
   * detached promise is fine in a long-lived process). Never awaited on the
   * tool-call path either way.
   */
  schedule?: (task: Promise<void>) => void;
  /** Sink for swallowed ingest failures (diagnostics only; default silent). */
  debug?: (message: string) => void;
}

/**
 * The `workspace` argument a tool call carried, when present. Usage events
 * are attributed to the workspace the tool was called with — tools without a
 * workspace in scope (`whoami`, `workspaces_list`) emit nothing rather than
 * guessing tenancy.
 */
export function workspaceOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const workspace = (input as Record<string, unknown>)["workspace"];
  return typeof workspace === "string" && workspace.length > 0 ? workspace : undefined;
}

/**
 * Fire-and-forget one `mcp.tool_call` usage event for a successful tool call.
 * Synchronous from the caller's perspective: kicks the ingest off and returns
 * immediately. Never throws; ingest failures are swallowed (debug note only).
 */
export function emitToolCallUsage(
  sdk: OrunCloud,
  tool: McpTool,
  input: unknown,
  usage: McpUsageOptions,
): void {
  if (!usage.enabled) return;
  const workspace = workspaceOf(input);
  if (workspace === undefined) return; // no tenancy in scope — skip, never guess
  try {
    const task = sdk.metering
      .recordUsage(workspace, {
        metric: MCP_TOOL_CALL_METRIC,
        quantity: 1,
        // Unique per logical call — the dedupe key exists for producer
        // retries; a fresh key per call means every call counts once.
        idempotencyKey: `mcp_call_${crypto.randomUUID()}`,
        // Dimensions ride the ingest contract's bounded metadata field
        // (`RecordUsageRequest.metadata` — no contract change needed).
        metadata: { tool: tool.name, transport: usage.transport },
      })
      .then(
        () => undefined,
        (err: unknown) => {
          usage.debug?.(
            `mcp.tool_call usage ingest failed for ${tool.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
    usage.schedule?.(task);
  } catch (err) {
    // A broken/stubbed SDK must not take the tool call down with it.
    usage.debug?.(
      `mcp.tool_call usage ingest failed for ${tool.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
