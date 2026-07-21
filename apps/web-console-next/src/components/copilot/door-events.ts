// The door-event fold (saas-copilot-surface CX3, design §5.1): pure helpers
// between the platform's AG-UI dialect (v1, @saas/contracts/agui) and the
// stock @ag-ui event stream the engine consumes. ALL engine coupling lives
// under components/copilot/ (lock 8) — and all protocol smarts live HERE,
// dependency-free, so jest covers them without a browser or the engine.
//
// Dialect deviations handled (design §1.1):
//  * MESSAGES_SNAPSHOT append-increments duplicate the streamed content for
//    durable rows — DROPPED for the engine (history hydrates via the GET).
//  * STATE_SNAPSHOT carries the resume watermark — passed through (the
//    engine stores it on agent.state; harmless, useful).
//  * seq fields ride along untouched (extra props are tolerated).

import type { AguiEvent } from "@saas/contracts/agui";
import { CLIENT_TOOL_NAMES } from "@saas/contracts/agui";

/** Incremental SSE parser: feed decoded text chunks, get parsed events. */
export function createSSEParser(): { push(chunk: string): AguiEvent[] } {
  let buf = "";
  return {
    push(chunk: string): AguiEvent[] {
      buf += chunk;
      const out: AguiEvent[] = [];
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            out.push(JSON.parse(line.slice(6)) as AguiEvent);
          } catch {
            // A torn event is dropped, never fatal (forward compatibility).
          }
        }
      }
      return out;
    },
  };
}

/** A stock-shaped event object (structural — the engine validates shape). */
export type StockEvent = Record<string, unknown> & { type: string };

/**
 * mapDoorEvent — dialect → stock. Returns [] for dialect-only events the
 * engine must not see; passes the shared vocabulary through with the small
 * completions stock schemas require (a TOOL_CALL_RESULT messageId).
 */
export function mapDoorEvent(e: AguiEvent): StockEvent[] {
  switch (e.type) {
    // Dialect-state events the chat engine does not consume — dropped so they
    // never violate the @ag-ui run verifier (a leading STATE_SNAPSHOT was the
    // "First event must be 'RUN_STARTED'" break; the server run door also gates
    // these, this is the belt-and-suspenders half).
    case "MESSAGES_SNAPSHOT": // append-increment: durable-row echo, history hydrates via GET
    case "STATE_SNAPSHOT":
    case "STATE_DELTA":
      return [];
    case "TOOL_CALL_RESULT":
      return [{ ...e, messageId: e.messageId ?? `result:${e.toolCallId ?? "unknown"}` }];
    case "RUN_STARTED":
    case "RUN_FINISHED":
    case "RUN_ERROR":
    case "TEXT_MESSAGE_START":
    case "TEXT_MESSAGE_CONTENT":
    case "TEXT_MESSAGE_END":
    case "TOOL_CALL_START":
    case "TOOL_CALL_ARGS":
    case "TOOL_CALL_END":
    case "CUSTOM":
      return [{ ...e }];
    default:
      return []; // unknown dialect events never reach the engine
  }
}

/**
 * ClientCallTracker — the CX2 side channel's eyes: accumulates
 * TOOL_CALL_START/ARGS for REGISTRY verbs and reports a completed client
 * call on TOOL_CALL_END, so the thread can execute the handler and post the
 * result while the server-side turn is paused.
 */
export interface CompletedClientCall {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
}

export function createClientCallTracker(): { fold(e: AguiEvent): CompletedClientCall | null } {
  const open = new Map<string, { name: string; args: string }>();
  return {
    fold(e: AguiEvent): CompletedClientCall | null {
      if (e.type === "TOOL_CALL_START" && e.toolCallId && e.toolCallName && CLIENT_TOOL_NAMES.has(e.toolCallName)) {
        open.set(e.toolCallId, { name: e.toolCallName, args: "" });
        return null;
      }
      if (e.type === "TOOL_CALL_ARGS" && e.toolCallId && open.has(e.toolCallId)) {
        open.get(e.toolCallId)!.args += e.delta ?? "";
        return null;
      }
      if (e.type === "TOOL_CALL_END" && e.toolCallId && open.has(e.toolCallId)) {
        const { name, args } = open.get(e.toolCallId)!;
        open.delete(e.toolCallId);
        let input: Record<string, unknown> = {};
        try {
          input = args ? (JSON.parse(args) as Record<string, unknown>) : {};
        } catch {
          // A malformed args blob still completes the call with empty input.
        }
        return { toolCallId: e.toolCallId, name, input };
      }
      return null;
    },
  };
}
