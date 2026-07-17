// AN4 (saas-agents-native): the Workspace Agent thread's live fold.

import {
  foldChatFrame,
  initialChatLiveState,
  mergeChatMessages,
  type ChatFrame,
  type ChatLiveState,
} from "@/lib/agents/chat-live";
import type { AgentChatMessage } from "@saas/sdk";

function foldAll(frames: ChatFrame[], start?: ChatLiveState): ChatLiveState {
  return frames.reduce(foldChatFrame, start ?? initialChatLiveState());
}

describe("chat-live fold", () => {
  it("folds replay + live messages, dedupes on reconnect overlap", () => {
    const first = foldAll([
      { t: "hello", title: "Ship ORN-142" },
      { t: "msg", seq: 0, role: "user", text: "what broke?", at: "t0" },
      { t: "msg", seq: 1, role: "assistant", text: "nothing.", at: "t1" },
      { t: "live" },
    ]);
    expect(first.messages.map((m) => m.seq)).toEqual([0, 1]);
    expect(first.title).toBe("Ship ORN-142");

    const resumed = foldAll(
      [
        { t: "msg", seq: 1, role: "assistant", text: "nothing.", at: "t1" },
        { t: "msg", seq: 2, role: "user", text: "good", at: "t2" },
      ],
      first,
    );
    expect(resumed.messages.map((m) => m.seq)).toEqual([0, 1, 2]);
  });

  it("accumulates deltas during a turn and clears on the durable message", () => {
    let s = foldAll([{ t: "turn", phase: "start" }, { t: "delta", text: "half " }, { t: "delta", text: "answer" }]);
    expect(s.turning).toBe(true);
    expect(s.streaming).toBe("half answer");
    s = foldChatFrame(s, { t: "msg", seq: 0, role: "assistant", text: "half answer", at: "t" });
    expect(s.streaming).toBe("");
    s = foldChatFrame(s, { t: "turn", phase: "done" });
    expect(s.turning).toBe(false);
  });

  it("renders tool cards and error turns from the frame fields", () => {
    const s = foldAll([
      { t: "msg", seq: 0, role: "tool", text: "", at: "t", tool: { name: "runs_list", phase: "result", summary: "3 runs" } },
      { t: "msg", seq: 1, role: "assistant", text: "custody failed", at: "t", error: true },
    ]);
    expect(s.messages[0]!.tool?.name).toBe("runs_list");
    expect(s.messages[1]!.error).toBe(true);
  });

  it("merges the HTTP history with live messages, deduped by seq", () => {
    const history: AgentChatMessage[] = [
      { seq: 0, role: "user", text: "a", at: "t" },
      { seq: 1, role: "assistant", text: "b", at: "t" },
    ];
    const live: AgentChatMessage[] = [
      { seq: 1, role: "assistant", text: "b", at: "t" },
      { seq: 2, role: "user", text: "c", at: "t" },
    ];
    expect(mergeChatMessages(history, live).map((m) => m.seq)).toEqual([0, 1, 2]);
  });
});
