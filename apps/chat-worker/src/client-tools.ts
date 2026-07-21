// Client tools (saas-copilot-surface CX2, design §3): the agent may REQUEST
// a frontend action; the browser EXECUTES it with the viewer's own session.
// This module is the DO-side half — a per-run broker that pauses the tool
// round awaiting the browser's result, with a bounded timeout so a closed
// laptop never wedges a thread (a synthesized error result lets the loop
// proceed). The tool surface is the CLOSED registry in contracts: free-form
// advertisement was rejected at the door before this module ever runs.
//
// Security stance (design §3.2, lock 4): nothing here executes anything —
// the broker only correlates a pending tool_use id with a POSTed result from
// the SAME viewer who started the run. Zero new authority, by construction.

import { CLIENT_TOOLS_V1, type AguiClientTool } from "@saas/contracts/agui";
import type { ToolExecutor, ToolSpec } from "./chat-thread.js";

export const CLIENT_TOOL_TIMEOUT_MS = 60_000;

export interface ClientToolResult {
  summary: string;
  data: unknown;
  isError?: boolean;
}

interface Pending {
  resolve: (r: ClientToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ClientToolBroker {
  /** The advertised tools' specs from the registry (model-facing). */
  specs(): ToolSpec[];
  has(name: string): boolean;
  /** Pause point: resolves when the browser posts, or on timeout with the
   * synthesized `client_timeout` error result. */
  awaitResult(toolCallId: string): Promise<ClientToolResult>;
  /** Single-use, id-matched: false for an unknown or already-settled id. */
  resolve(toolCallId: string, content: string, isError?: boolean): boolean;
  /** Open call ids (assertable; also the "is anything pending" signal). */
  pending(): string[];
}

/**
 * createClientToolBroker — one per run. `advertised` has already passed
 * validClientTools at the door; specs come from the REGISTRY (never the
 * client's copy), so a head cannot widen a description or schema.
 */
export function createClientToolBroker(
  advertised: AguiClientTool[],
  opts: { timeoutMs?: number } = {},
): ClientToolBroker {
  const timeoutMs = opts.timeoutMs ?? CLIENT_TOOL_TIMEOUT_MS;
  const names = new Set(advertised.map((t) => t.name));
  const registry = CLIENT_TOOLS_V1.filter((t) => names.has(t.name));
  const waiting = new Map<string, Pending>();

  return {
    specs(): ToolSpec[] {
      return registry.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
    },
    has(name: string): boolean {
      return names.has(name);
    },
    awaitResult(toolCallId: string): Promise<ClientToolResult> {
      return new Promise<ClientToolResult>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(toolCallId);
          resolve({ summary: "client_timeout — no result from the viewer's browser", data: { error: "client_timeout" }, isError: true });
        }, timeoutMs);
        waiting.set(toolCallId, { resolve, timer });
      });
    },
    resolve(toolCallId: string, content: string, isError?: boolean): boolean {
      const p = waiting.get(toolCallId);
      if (!p) return false;
      waiting.delete(toolCallId);
      clearTimeout(p.timer);
      p.resolve({ summary: content, data: { content }, ...(isError ? { isError: true } : {}) });
      return true;
    },
    pending(): string[] {
      return [...waiting.keys()];
    },
  };
}

/**
 * withClientTools — the executor seam: client-tool calls pause on the broker;
 * everything else flows to the inner (owner-credentialed) executor untouched.
 */
export function withClientTools(inner: ToolExecutor, broker: ClientToolBroker): ToolExecutor {
  return {
    specs: () => [...inner.specs(), ...broker.specs()],
    execute: async (name, input, callId) => {
      if (broker.has(name)) {
        // The call card is already on the wire (the loop appends it before
        // execute); the browser sees TOOL_CALL_START/ARGS and acts.
        return broker.awaitResult(callId ?? name);
      }
      return inner.execute(name, input, callId);
    },
  };
}
