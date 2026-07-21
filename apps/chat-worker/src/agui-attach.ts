// The Bridge, session dialect (saas-copilot-surface CX0, design §1.3):
// attach-v1 frames → AG-UI events. Sessions are not conversations — they are
// activity streams — so the mapping rides AG-UI's state + custom lanes and
// never pretends session events are chat text. A Managed run (DX7) flows
// through the identical mapping; the trust tier rides STATE_SNAPSHOT so the
// lens renders it permanently (DX lock 8, inherited).
//
// Pure fold, no I/O — the twin of agui.ts for the attach wire.

import { AGUI_DIALECT_VERSION, type AguiEvent } from "@saas/contracts/agui";

/** The attach-v1 frame surface the bridge consumes (@saas/contracts
 * agents-attach AttachFrame, structurally). */
export interface AttachV1Frame {
  v?: number;
  t?: string;
  sessionId?: string;
  state?: string;
  briefId?: string;
  agentType?: string;
  task?: string;
  runKind?: string;
  harness?: string;
  model?: string;
  latestSeq?: number;
  seq?: number;
  kind?: string;
  at?: string;
  payload?: Record<string, unknown>;
  turn?: number;
  text?: string;
  heads?: Array<{ principal: string; surface: string }>;
  ref?: string;
  code?: string;
  message?: string;
}

export interface AttachBridgeState {
  sessionId: string;
  /** Open streamed transcript message per turn (`<sessionId>:t<turn>`). */
  openTurn: number | null;
}

export function attachBridgeInitial(sessionId: string): AttachBridgeState {
  return { sessionId, openTurn: null };
}

function ev(partial: Omit<AguiEvent, "v">): AguiEvent {
  return { v: AGUI_DIALECT_VERSION, ...partial };
}

function turnMessageId(sessionId: string, turn: number): string {
  return `${sessionId}:t${turn}`;
}

/**
 * translateAttachFrame: one attach-v1 body frame → AG-UI events + next state.
 * Unknown frame types and event kinds degrade to nothing / a generic
 * activity event — the lens renders what the stream carries and says so
 * (the DX honest-degradation idiom; risks R7).
 */
export function translateAttachFrame(
  state: AttachBridgeState,
  frame: AttachV1Frame,
): { state: AttachBridgeState; events: AguiEvent[] } {
  switch (frame.t) {
    case "hello": {
      return {
        state,
        events: [
          ev({
            type: "STATE_SNAPSHOT",
            snapshot: {
              sessionId: frame.sessionId ?? state.sessionId,
              ...(frame.state ? { state: frame.state } : {}),
              ...(frame.agentType ? { agentType: frame.agentType } : {}),
              ...(frame.task ? { task: frame.task } : {}),
              ...(frame.runKind ? { runKind: frame.runKind } : {}),
              ...(frame.harness ? { harness: frame.harness } : {}),
              ...(frame.model ? { model: frame.model } : {}),
              cursor: frame.latestSeq ?? -1,
            },
          }),
        ],
      };
    }

    case "event": {
      const seq = frame.seq;
      const kind = frame.kind ?? "";
      const payload = frame.payload ?? {};
      const carry = seq !== undefined ? { seq } : {};

      // The AG7 state machine, verbatim, as a replace op.
      if (kind === "state_changed" && typeof payload.state === "string") {
        return {
          state,
          events: [ev({ type: "STATE_DELTA", ops: [{ op: "replace", path: "/state", value: payload.state }], ...carry })],
        };
      }
      // The meter tick the lens renders live against the AF9 envelope.
      if (kind === "cost_sample") {
        return { state, events: [ev({ type: "CUSTOM", name: "cost", value: payload, ...carry })] };
      }
      // The §6 approval card — server-emitted only; the card renderer trusts
      // exactly this event and nothing client-side.
      if (kind === "approval_requested") {
        return {
          state,
          events: [
            ev({
              type: "CUSTOM",
              name: "approval",
              value: { ...payload, ...(frame.ref ? { ref: frame.ref } : {}) },
              ...carry,
            }),
          ],
        };
      }
      // Tool-shaped events ride the TOOL_CALL lanes so the thread and the
      // lens share card renderers.
      if (kind.startsWith("tool_") || kind === "tool") {
        const name = typeof payload.name === "string" ? payload.name : kind;
        const toolCallId = typeof payload.id === "string" ? payload.id : `tc_${seq ?? "x"}`;
        const phase = typeof payload.phase === "string" ? payload.phase : "result";
        if (phase === "call") {
          return {
            state,
            events: [
              ev({ type: "TOOL_CALL_START", toolCallId, toolCallName: name, ...carry }),
              ev({ type: "TOOL_CALL_ARGS", toolCallId, delta: typeof payload.summary === "string" ? payload.summary : "" }),
            ],
          };
        }
        return {
          state,
          events: [
            ev({ type: "TOOL_CALL_END", toolCallId, ...carry }),
            ev({
              type: "TOOL_CALL_RESULT",
              toolCallId,
              content: typeof payload.summary === "string" ? payload.summary : "",
              ...(payload.isError ? { isError: true } : {}),
              ...carry,
            }),
          ],
        };
      }
      // Everything else: a plane-tagged activity line, never merged into chat.
      return {
        state,
        events: [ev({ type: "CUSTOM", name: "activity", value: { kind, ...(frame.at ? { at: frame.at } : {}), payload }, ...carry })],
      };
    }

    case "delta": {
      // Live transcript deltas, one streamed message per turn.
      const turn = frame.turn ?? 0;
      const messageId = turnMessageId(state.sessionId, turn);
      const events: AguiEvent[] = [];
      let next = state;
      if (state.openTurn !== turn) {
        if (state.openTurn !== null) {
          events.push(ev({ type: "TEXT_MESSAGE_END", messageId: turnMessageId(state.sessionId, state.openTurn) }));
        }
        events.push(ev({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" }));
        next = { ...state, openTurn: turn };
      }
      events.push(ev({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: frame.text ?? "" }));
      return { state: next, events };
    }

    case "presence": {
      return { state, events: [ev({ type: "CUSTOM", name: "presence", value: { heads: frame.heads ?? [] } })] };
    }

    case "error": {
      return {
        state,
        events: [ev({ type: "RUN_ERROR", ...(frame.code ? { code: frame.code } : {}), message: frame.message ?? "attach error" })],
      };
    }

    case "bye": {
      const events: AguiEvent[] = [];
      if (state.openTurn !== null) {
        events.push(ev({ type: "TEXT_MESSAGE_END", messageId: turnMessageId(state.sessionId, state.openTurn) }));
      }
      events.push(ev({ type: "CUSTOM", name: "bye" }));
      return { state: { ...state, openTurn: null }, events };
    }

    // `live`, `ack`, `ping` and unknown types carry no lens meaning.
    default:
      return { state, events: [] };
  }
}

/** Convenience: fold a recorded frame sequence (tests, watch replay). */
export function translateAttachFrames(
  state: AttachBridgeState,
  frames: AttachV1Frame[],
): { state: AttachBridgeState; events: AguiEvent[] } {
  const out: AguiEvent[] = [];
  let s = state;
  for (const f of frames) {
    const r = translateAttachFrame(s, f);
    s = r.state;
    out.push(...r.events);
  }
  return { state: s, events: out };
}
