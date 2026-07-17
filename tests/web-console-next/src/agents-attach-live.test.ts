// AN2 (saas-agents-native): the console head's live-tail fold — attach-v1
// frames into head state. Pure, so the whole socket behavior contract
// (dedupe, cursor resume, delta supersession, presence, bye) tests here.

import {
  foldAttachFrame,
  initialAttachLiveState,
  type AttachLiveState,
  type LiveFrame,
} from "@/lib/agents/attach-live";

function foldAll(frames: LiveFrame[], start?: AttachLiveState): AttachLiveState {
  return frames.reduce(foldAttachFrame, start ?? initialAttachLiveState());
}

describe("attach-live fold", () => {
  it("folds replay + live events in order and advances the cursor", () => {
    const s = foldAll([
      { t: "hello", state: "running", latestSeq: 2 },
      { t: "event", seq: 0, kind: "state_changed", payload: { state: "running" } },
      { t: "event", seq: 1, kind: "message_agent", payload: { text: "reading brief" } },
      { t: "live" },
      { t: "event", seq: 2, kind: "tool_call", payload: { tool: "catalog_affected" } },
    ]);
    expect(s.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(s.cursor).toBe(2);
    expect(s.sessionState).toBe("running");
  });

  it("drops reconnect overlap (seq <= cursor) — resume is gapless and dupe-free", () => {
    const first = foldAll([
      { t: "event", seq: 0, kind: "message_agent" },
      { t: "event", seq: 1, kind: "message_agent" },
    ]);
    // Reconnect replays from the cursor: the relay resends seq 1, then news.
    const resumed = foldAll(
      [
        { t: "hello", state: "running" },
        { t: "event", seq: 1, kind: "message_agent" },
        { t: "event", seq: 2, kind: "message_agent" },
      ],
      first,
    );
    expect(resumed.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("accumulates deltas within a turn, replaces across turns, clears on the durable event", () => {
    let s = foldAll([
      { t: "delta", turn: 1, text: "impl" },
      { t: "delta", turn: 1, text: "ementing" },
    ]);
    expect(s.streaming).toBe("implementing");
    s = foldAttachFrame(s, { t: "delta", turn: 2, text: "next" });
    expect(s.streaming).toBe("next");
    s = foldAttachFrame(s, { t: "event", seq: 0, kind: "message_agent", payload: { text: "next turn done" } });
    expect(s.streaming).toBe("");
  });

  it("tracks presence and state changes; bye marks the tail ended", () => {
    const s = foldAll([
      { t: "presence", heads: [{ principal: "usr_a", surface: "console" }, { principal: "usr_b", surface: "tui" }] },
      { t: "event", seq: 0, kind: "state_changed", payload: { state: "awaiting_approval" } },
      { t: "bye", reason: "terminal" },
    ]);
    expect(s.heads.map((h) => h.surface).sort()).toEqual(["console", "tui"]);
    expect(s.sessionState).toBe("awaiting_approval");
    expect(s.ended).toBe(true);
  });

  it("ignores unknown frame vocabulary (forward compatibility)", () => {
    const s = foldAll([
      { t: "event", seq: 0, kind: "message_agent" },
      { t: "future_frame_kind" } as LiveFrame,
      { t: "ping", at: "2026-07-17T00:00:00Z" },
    ]);
    expect(s.events).toHaveLength(1);
  });
});
