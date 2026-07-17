// chat-live — the Workspace Agent thread's live fold (saas-agents-native
// AN4): chat-v1 frames into head state. The same pure-fold idiom as the
// session head's attach-live; a reconnect resumes from the cursor (highest
// message seq folded), so a second browser picks up the thread mid-stream.

import type { AgentChatMessage } from "@saas/sdk";

export interface ChatFrame {
  v?: number;
  t?: string;
  seq?: number;
  role?: string;
  text?: string;
  at?: string;
  tool?: { name: string; phase: "call" | "result"; summary: string; isError?: boolean };
  principal?: string;
  error?: boolean;
  chatId?: string;
  title?: string;
  latestSeq?: number;
  phase?: string;
}

export interface ChatLiveState {
  messages: AgentChatMessage[];
  cursor: number;
  /** The in-progress assistant turn's streamed text (cleared on the durable
   * message and on turn end). */
  streaming: string;
  /** True while a turn is running (between turn:start and turn:done). */
  turning: boolean;
  title?: string;
}

export function initialChatLiveState(cursor = -1): ChatLiveState {
  return { messages: [], cursor, streaming: "", turning: false };
}

export function foldChatFrame(state: ChatLiveState, frame: ChatFrame): ChatLiveState {
  switch (frame.t) {
    case "hello": {
      const next = { ...state };
      if (frame.title) next.title = frame.title;
      return next;
    }
    case "msg": {
      if (typeof frame.seq !== "number" || frame.seq <= state.cursor) return state;
      const msg: AgentChatMessage = {
        seq: frame.seq,
        role: (frame.role as AgentChatMessage["role"]) ?? "assistant",
        text: frame.text ?? "",
        at: frame.at ?? "",
        ...(frame.tool ? { tool: frame.tool } : {}),
        ...(frame.principal ? { principal: frame.principal } : {}),
        ...(frame.error ? { error: true } : {}),
      };
      return {
        ...state,
        messages: [...state.messages, msg],
        cursor: frame.seq,
        streaming: "",
      };
    }
    case "delta":
      return { ...state, streaming: state.streaming + (frame.text ?? "") };
    case "turn":
      if (frame.phase === "start") return { ...state, turning: true };
      return { ...state, turning: false, streaming: "" };
    case "bye":
      return { ...state, turning: false, streaming: "" };
    default:
      return state;
  }
}

/** mergeHistory unions the HTTP history load with live-folded messages,
 * deduped by seq (the reconnect discipline shared with the session head). */
export function mergeChatMessages(history: AgentChatMessage[], live: AgentChatMessage[]): AgentChatMessage[] {
  const maxHistory = history.reduce((m, e) => Math.max(m, e.seq), -1);
  return [...history, ...live.filter((m) => m.seq > maxHistory)];
}
