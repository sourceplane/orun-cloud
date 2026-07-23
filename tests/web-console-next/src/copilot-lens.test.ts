// The delegated-session lens fold (saas-copilot-surface CX4/CX5): state
// timeline from STATE_DELTA, tool lanes, cost accumulation, plane-honest
// activity, and the §6 approval guard — a card exists ONLY from a server
// CUSTOM {name:"approval"} event; activity payloads that merely look
// approval-ish never produce one; resolution collapses by requestId.

import { foldLensEvent, initialLensState } from "@web-console-next/components/copilot/session-lens";
import type { AguiEvent } from "@saas/contracts/agui";

const fold = (events: AguiEvent[]) => events.reduce(foldLensEvent, initialLensState());

describe("CX4: the lens fold", () => {
  it("builds the state timeline and tracks the cursor", () => {
    const s = fold([
      { v: 1, type: "STATE_SNAPSHOT", snapshot: { sessionId: "as_1", state: "running", cursor: 4 } },
      { v: 1, type: "STATE_DELTA", seq: 5, ops: [{ op: "replace", path: "/state", value: "awaiting_approval" }] },
      { v: 1, type: "STATE_DELTA", seq: 9, ops: [{ op: "replace", path: "/state", value: "completed" }] },
    ]);
    expect(s.sessionState).toBe("completed");
    expect(s.timeline.map((t) => t.state)).toEqual(["awaiting_approval", "completed"]);
    expect(s.cursor).toBe(9);
  });

  it("accumulates cost ticks and folds tool lanes", () => {
    const s = fold([
      { v: 1, type: "CUSTOM", name: "cost", seq: 1, value: { tokens: 800 } },
      { v: 1, type: "CUSTOM", name: "cost", seq: 2, value: { tokens: 200 } },
      { v: 1, type: "TOOL_CALL_START", toolCallId: "tu_1", toolCallName: "bash", seq: 3 },
      { v: 1, type: "TOOL_CALL_RESULT", toolCallId: "tu_1", content: "72 passed", seq: 4 },
    ]);
    expect(s.tokens).toBe(1000);
    expect(s.tools[0]).toMatchObject({ name: "bash", result: "72 passed" });
  });

  it("renders activity honestly and streams per-turn deltas", () => {
    const s = fold([
      { v: 1, type: "CUSTOM", name: "activity", seq: 1, value: { kind: "status_asserted", payload: { note: "x" } } },
      { v: 1, type: "TEXT_MESSAGE_CONTENT", delta: "half " },
      { v: 1, type: "TEXT_MESSAGE_CONTENT", delta: "done" },
    ]);
    expect(s.activity[0]).toMatchObject({ kind: "status_asserted" });
    expect(s.streaming).toBe("half done");
    expect(foldLensEvent(s, { v: 1, type: "TEXT_MESSAGE_END" }).streaming).toBe("");
  });
});

describe("CX5: the approval guard (design §6)", () => {
  it("a card exists ONLY from a server CUSTOM approval event", () => {
    const s = fold([
      // Approval-ish content on the WRONG lane must not mint a card.
      { v: 1, type: "CUSTOM", name: "activity", seq: 1, value: { kind: "log", payload: { requestId: "apr_x", tool: "bash" } } },
      { v: 1, type: "CUSTOM", name: "approval", seq: 2, value: { requestId: "apr_1", tool: "bash", reason: "wants to deploy" } },
      // Missing requestId → no card (a server bug degrades honestly).
      { v: 1, type: "CUSTOM", name: "approval", seq: 3, value: { tool: "bash" } },
    ]);
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0]).toMatchObject({ requestId: "apr_1", tool: "bash", reason: "wants to deploy" });
  });

  it("resolution collapses the card by requestId, from the server stream only", () => {
    const s = fold([
      { v: 1, type: "CUSTOM", name: "approval", seq: 1, value: { requestId: "apr_1", tool: "bash" } },
      { v: 1, type: "CUSTOM", name: "activity", seq: 2, value: { kind: "approval_resolved", payload: { requestId: "apr_1", approved: true } } },
    ]);
    expect(s.approvals[0]).toMatchObject({ resolved: true, approved: true });
  });
});

describe("the lens transcript (the session's copilot head)", () => {
  it("folds user steers + agent turns into chronological bubbles, never activity noise", () => {
    const s = fold([
      { v: 1, type: "CUSTOM", name: "activity", seq: 1, value: { kind: "message_user", payload: { text: "Hi", principal: "usr_1" } } },
      { v: 1, type: "TEXT_MESSAGE_CONTENT", delta: "Hello " },
      { v: 1, type: "TEXT_MESSAGE_CONTENT", delta: "there" },
      { v: 1, type: "TEXT_MESSAGE_END", messageId: "m1" },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(s.items[0]).toMatchObject({ text: "Hi", principal: "usr_1" });
    expect(s.items[1]).toMatchObject({ text: "Hello there" });
    expect(s.streaming).toBe("");
    expect(s.activity).toHaveLength(0);
  });

  it("the durable message_agent copy of a streamed turn is deduped; a replay-only turn still lands", () => {
    const streamed = fold([
      { v: 1, type: "TEXT_MESSAGE_CONTENT", delta: "done" },
      { v: 1, type: "TEXT_MESSAGE_END", messageId: "m1" },
      { v: 1, type: "CUSTOM", name: "activity", seq: 4, value: { kind: "message_agent", payload: { text: "done" } } },
    ]);
    expect(streamed.items.filter((i) => i.kind === "assistant")).toHaveLength(1);

    const replayOnly = fold([
      { v: 1, type: "CUSTOM", name: "activity", seq: 4, value: { kind: "message_agent", payload: { text: "done" } } },
    ]);
    expect(replayOnly.items).toEqual([{ kind: "assistant", id: "a_4", text: "done" }]);
  });

  it("RUN_ERROR and error events become sanitized error cards — raw HTML never renders", () => {
    const s = fold([
      { v: 1, type: "RUN_ERROR", message: "API Error: 404 <!DOCTYPE html><html><head>lots of markup</head></html>" },
      { v: 1, type: "CUSTOM", name: "activity", seq: 9, value: { kind: "error", payload: { text: "plain failure" } } },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["error", "error"]);
    expect(s.items[0]!.text).toContain("API Error: 404");
    expect(s.items[0]!.text).toContain("Base URL");
    expect(s.items[0]!.text).not.toContain("<html");
    expect(s.items[1]!.text).toBe("plain failure");
  });
});
