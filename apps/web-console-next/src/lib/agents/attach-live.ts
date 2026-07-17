// attach-live — the console head's live-tail state machine (saas-agents-native
// AN2). Pure: `foldAttachFrame` folds one attach-v1 frame into the head state;
// the socket hook (attach-socket.ts) is a thin transport around it. The frame
// protocol IS the resume protocol — `cursor` (highest event seq folded) is the
// `from` a reconnect dials with, so a killed socket resumes with no gap and no
// duplicates (the relay replays seq > from; dedupe below absorbs overlap).

/** One attach-v1 frame, structurally typed (the console consumes a subset). */
export interface LiveFrame {
  v?: number;
  t?: string;
  seq?: number;
  kind?: string;
  at?: string;
  payload?: Record<string, unknown>;
  turn?: number;
  text?: string;
  heads?: { principal: string; surface: string }[];
  state?: string;
  latestSeq?: number;
  reason?: string;
}

export interface LiveEvent {
  seq: number;
  kind: string;
  at?: string;
  payload?: Record<string, unknown>;
}

export interface AttachLiveState {
  /** Events folded from replay + live fan-out, seq-ascending, deduped. */
  events: LiveEvent[];
  /** Highest seq folded — the reconnect cursor. */
  cursor: number;
  /** The in-progress turn's streaming text (wire-only; cleared when the
   * turn's durable event lands). */
  streaming: string;
  streamingTurn: number;
  /** Currently attached heads (advisory presence). */
  heads: { principal: string; surface: string }[];
  /** The session state as the relay last announced it. */
  sessionState?: string;
  /** True once the relay said bye (terminal). */
  ended: boolean;
}

export function initialAttachLiveState(cursor = -1): AttachLiveState {
  return { events: [], cursor, streaming: "", streamingTurn: 0, heads: [], ended: false };
}

/**
 * foldAttachFrame: one frame in, the next state out. Unknown frame types are
 * ignored (forward compatibility); duplicate seqs are dropped (the reconnect
 * overlap); a delta for a NEW turn replaces the streaming line; any durable
 * event clears it (the fold's final message supersedes the token stream).
 */
export function foldAttachFrame(state: AttachLiveState, frame: LiveFrame): AttachLiveState {
  switch (frame.t) {
    case "hello": {
      const next = { ...state };
      if (typeof frame.state === "string" && frame.state) next.sessionState = frame.state;
      return next;
    }
    case "event": {
      if (typeof frame.seq !== "number" || !frame.kind) return state;
      if (frame.seq <= state.cursor) return state; // reconnect overlap / dupe
      const ev: LiveEvent = { seq: frame.seq, kind: frame.kind };
      if (frame.at) ev.at = frame.at;
      if (frame.payload) ev.payload = frame.payload;
      const next: AttachLiveState = {
        ...state,
        events: [...state.events, ev],
        cursor: frame.seq,
        streaming: "",
      };
      if (frame.kind === "state_changed" && typeof frame.payload?.state === "string") {
        next.sessionState = frame.payload.state as string;
      }
      return next;
    }
    case "delta": {
      const turn = frame.turn ?? 0;
      const text = frame.text ?? "";
      if (!text) return state;
      return {
        ...state,
        streaming: turn === state.streamingTurn ? state.streaming + text : text,
        streamingTurn: turn,
      };
    }
    case "presence":
      return { ...state, heads: frame.heads ?? [] };
    case "bye":
      return { ...state, ended: true, streaming: "" };
    default:
      return state; // live marker, ping, unknown vocabulary
  }
}
