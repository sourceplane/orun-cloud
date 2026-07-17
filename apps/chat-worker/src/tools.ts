// tools — the Workspace Agent's toolset v1 (saas-agents-native AN4, design
// §6.1 first row): the READ-ONLY slice of the shipped platform MCP, consumed
// as the same @saas/mcp registry the remote transport serves and executed
// with an SDK bound to api-edge under the CHAT OWNER's credential. One tool
// plane, zero new governance surface: RBAC, rate limits, audit, and metering
// apply because every call re-enters the public door.
//
// STRUCTURAL read-only (design §5.3 — "nothing in its toolset CAN execute"):
// the roster is `readOnlyTools` from the registry, and a belt-and-suspenders
// filter drops anything whose readOnlyHint isn't true. The CI assertion in
// tests/chat-worker pins that no write-capable tool is reachable.

import { readOnlyTools, toWireInputSchema, DEFAULT_LIMITS, type McpTool } from "@saas/mcp";
import { OrunCloud } from "@saas/sdk";
import type { ToolExecutor, ToolSpec } from "./chat-thread.js";

/** The read-only roster — the single source the loop sees. */
export function readOnlyRoster(): McpTool[] {
  return readOnlyTools.filter((t) => t.annotations.readOnlyHint === true);
}

function toSpec(tool: McpTool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toWireInputSchema(tool.inputSchema),
  };
}

/**
 * createOwnerToolExecutor — platform tools executed with the chat owner's
 * bearer via api-edge. Tool errors come back as results (is_error), never
 * throws: the model gets an honest failure and the thread shows it.
 */
export function createOwnerToolExecutor(opts: {
  baseUrl: string;
  ownerToken: string;
  fetchFn?: typeof fetch;
}): ToolExecutor {
  const sdk = new OrunCloud({
    baseUrl: opts.baseUrl,
    auth: { kind: "bearer", token: opts.ownerToken },
    ...(opts.fetchFn ? { fetch: opts.fetchFn } : {}),
  });
  const roster = readOnlyRoster();
  const byName = new Map(roster.map((t) => [t.name, t]));

  return {
    specs(): ToolSpec[] {
      return roster.map(toSpec);
    },
    async execute(name, input) {
      const tool = byName.get(name);
      if (!tool) {
        // Structurally unreachable for write tools: they are not in the
        // roster, so the model cannot call them — and if it hallucinates a
        // name, this is the honest refusal.
        return { summary: `tool ${name} is not available`, data: { error: "tool_not_available" }, isError: true };
      }
      try {
        // The registry handler parses input against the tool's schema before
        // invoking (defineTool's contract) — same execution semantics as the
        // remote transport, same public-surface re-entry.
        const result = await tool.handler(input, { sdk, limits: DEFAULT_LIMITS });
        return { summary: result.summary, data: result.data };
      } catch (err) {
        return { summary: `tool ${name} failed: ${(err as Error).message}`, data: { error: String((err as Error).message) }, isError: true };
      }
    },
  };
}
