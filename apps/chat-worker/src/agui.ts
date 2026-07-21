// The Bridge, chat dialect (saas-copilot-surface CX0, design §1.2): chat-v1
// frames → AG-UI events. A PURE fold — no I/O, no bindings, jest drives it
// with recorded frames (the ChatThread/RelayCore discipline). The DO calls
// this only at the run/watch doors (CX1); deleting the epic deletes this
// file and nothing else moves.
//
// Same seq, same cursor, no second truth: every event derived from a
// seq-bearing frame carries that seq so heads can dedupe across the WS fold
// and this dialect.

import { AGUI_DIALECT_VERSION, type AguiEvent, type AguiMessage } from "@saas/contracts/agui";

/** The chat-v1 frame surface the bridge consumes (chat-thread.ts fanOut). */
export interface ChatV1Frame {
  t?: string;
  seq?: number;
  role?: string;
  text?: string;
  at?: string;
  tool?: { name: string; phase: "call" | "result"; summary: string; isError?: boolean };
  /** The loop's tool_use id, when the emitter threads it (CX1 extension);
   * absent on legacy frames — the fold then matches results by name. */
  toolId?: string;
  principal?: string;
  error?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  chatId?: string;
  title?: string;
  latestSeq?: number;
  phase?: string;
}

export interface ChatBridgeState {
  threadId: string;
  /** The active run id (`<chatId>:r<n>` unless the door supplied one). */
  runId: string | null;
  /** Door-supplied run id for the NEXT turn:start (run door, design §2.1). */
  pendingRunId: string | null;
  runCounter: number;
  /** Open streamed assistant message id, if a TEXT_MESSAGE_START is live. */
  openMessageId: string | null;
  streamCounter: number;
  /** Open tool calls by name → toolCallId (legacy frames carry no id). */
  openToolCalls: Record<string, string>;
}

export function chatBridgeInitial(threadId: string, runId?: string): ChatBridgeState {
  return {
    threadId,
    runId: null,
    pendingRunId: runId ?? null,
    runCounter: 0,
    openMessageId: null,
    streamCounter: 0,
    openToolCalls: {},
  };
}

function ev(partial: Omit<AguiEvent, "v">): AguiEvent {
  return { v: AGUI_DIALECT_VERSION, ...partial };
}

function toMessage(frame: ChatV1Frame): AguiMessage {
  return {
    seq: frame.seq ?? -1,
    role: (frame.role as AguiMessage["role"]) ?? "assistant",
    text: frame.text ?? "",
    ...(frame.at ? { at: frame.at } : {}),
    ...(frame.tool ? { tool: frame.tool } : {}),
    ...(frame.principal ? { principal: frame.principal } : {}),
    ...(frame.error ? { error: true } : {}),
    ...(frame.usage ? { usage: frame.usage } : {}),
  };
}

/**
 * translateChatFrame: one chat-v1 frame → zero or more AG-UI events plus the
 * next fold state. Frame order is the DO's emission order; the fold never
 * reorders or buffers.
 */
export function translateChatFrame(
  state: ChatBridgeState,
  frame: ChatV1Frame,
): { state: ChatBridgeState; events: AguiEvent[] } {
  switch (frame.t) {
    case "hello": {
      // Watch door only: the resume watermark + title.
      return {
        state,
        events: [
          ev({
            type: "STATE_SNAPSHOT",
            snapshot: {
              threadId: state.threadId,
              ...(frame.title ? { title: frame.title } : {}),
              cursor: frame.latestSeq ?? -1,
            },
          }),
        ],
      };
    }

    case "turn": {
      if (frame.phase === "start") {
        const runId = state.pendingRunId ?? `${state.threadId}:r${state.runCounter + 1}`;
        return {
          state: { ...state, runId, pendingRunId: null, runCounter: state.runCounter + 1 },
          events: [ev({ type: "RUN_STARTED", threadId: state.threadId, runId })],
        };
      }
      // done (or any terminal phase): close a dangling stream, then the run.
      const events: AguiEvent[] = [];
      if (state.openMessageId) events.push(ev({ type: "TEXT_MESSAGE_END", messageId: state.openMessageId }));
      events.push(
        ev({ type: "RUN_FINISHED", threadId: state.threadId, ...(state.runId ? { runId: state.runId } : {}) }),
      );
      return { state: { ...state, runId: null, openMessageId: null, openToolCalls: {} }, events };
    }

    case "delta": {
      const events: AguiEvent[] = [];
      let next = state;
      if (!state.openMessageId) {
        const messageId = `${state.runId ?? state.threadId}:m${state.streamCounter + 1}`;
        next = { ...state, openMessageId: messageId, streamCounter: state.streamCounter + 1 };
        events.push(ev({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" }));
      }
      events.push(
        ev({ type: "TEXT_MESSAGE_CONTENT", messageId: next.openMessageId!, delta: frame.text ?? "" }),
      );
      return { state: next, events };
    }

    case "msg": {
      const seq = frame.seq;
      // Any durable row closes the open streamed message — the client fold
      // clears its streaming buffer on every `msg`, and the bridge mirrors
      // that: post-tool deltas open a fresh streamed message.
      const closing: AguiEvent[] = [];
      let next = state;
      if (state.openMessageId) {
        closing.push(ev({ type: "TEXT_MESSAGE_END", messageId: state.openMessageId }));
        next = { ...state, openMessageId: null };
      }

      // Tool rounds → TOOL_CALL_* lanes.
      if (frame.tool) {
        if (frame.tool.phase === "call") {
          const toolCallId = frame.toolId ?? `tc_${seq ?? "x"}`;
          return {
            state: { ...next, openToolCalls: { ...next.openToolCalls, [frame.tool.name]: toolCallId } },
            events: [
              ...closing,
              ev({ type: "TOOL_CALL_START", toolCallId, toolCallName: frame.tool.name, ...(seq !== undefined ? { seq } : {}) }),
              ev({ type: "TOOL_CALL_ARGS", toolCallId, delta: frame.tool.summary ?? "" }),
            ],
          };
        }
        // result: match the loop's id when threaded, else the open call by name.
        const matched = frame.toolId ?? next.openToolCalls[frame.tool.name] ?? `tc_${seq ?? "x"}`;
        const remaining = { ...next.openToolCalls };
        delete remaining[frame.tool.name];
        return {
          state: { ...next, openToolCalls: remaining },
          events: [
            ...closing,
            ev({ type: "TOOL_CALL_END", toolCallId: matched, ...(seq !== undefined ? { seq } : {}) }),
            ev({
              type: "TOOL_CALL_RESULT",
              toolCallId: matched,
              content: frame.tool.summary ?? "",
              ...(frame.tool.isError ? { isError: true } : {}),
              ...(seq !== undefined ? { seq } : {}),
            }),
          ],
        };
      }

      const events: AguiEvent[] = [...closing];
      // The honest error turn stays a first-class event; the following
      // turn:done frame closes the run (chat-thread emits both).
      if (frame.error) {
        events.push(
          ev({
            type: "RUN_ERROR",
            message: frame.text ?? "turn failed",
            ...(next.runId ? { runId: next.runId } : {}),
            ...(seq !== undefined ? { seq } : {}),
          }),
        );
      }
      // Dialect: append-only snapshot increment (design §1.1 deviation).
      events.push(
        ev({ type: "MESSAGES_SNAPSHOT", append: true, messages: [toMessage(frame)], ...(seq !== undefined ? { seq } : {}) }),
      );
      return { state: next, events };
    }

    // `live` (replay boundary) and `bye` carry no AG-UI meaning; unknown
    // frame types are ignored (forward compatibility, both directions).
    default:
      return { state, events: [] };
  }
}

/** Convenience: fold a whole recorded frame sequence (tests, watch replay). */
export function translateChatFrames(state: ChatBridgeState, frames: ChatV1Frame[]): { state: ChatBridgeState; events: AguiEvent[] } {
  const out: AguiEvent[] = [];
  let s = state;
  for (const f of frames) {
    const r = translateChatFrame(s, f);
    s = r.state;
    out.push(...r.events);
  }
  return { state: s, events: out };
}
