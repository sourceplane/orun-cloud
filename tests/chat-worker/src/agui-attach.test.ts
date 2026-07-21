// The Bridge, session dialect (saas-copilot-surface CX0, design §1.3):
// attach-v1 frames → AG-UI. Sessions are activity streams, not chat — state
// rides STATE_DELTA, activity/cost/approval ride typed CUSTOM events, tool
// steps share the thread's TOOL_CALL lanes, transcript deltas stream one
// message per turn. Seq is preserved; unknown kinds degrade honestly.

import {
  attachBridgeInitial,
  translateAttachFrame,
  translateAttachFrames,
  type AttachV1Frame,
} from "@chat-worker/agui-attach";

const S = "as_1";

describe("CX0: attach-v1 → AG-UI", () => {
  it("maps hello to a STATE_SNAPSHOT carrying identity + resume watermark", () => {
    const { events } = translateAttachFrame(attachBridgeInitial(S), {
      t: "hello",
      sessionId: S,
      state: "running",
      agentType: "implementer",
      runKind: "implementation",
      model: "claude-opus-4-8",
      latestSeq: 17,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "STATE_SNAPSHOT",
      snapshot: { sessionId: S, state: "running", runKind: "implementation", cursor: 17 },
    });
  });

  it("maps state_changed to a replace op on /state, seq preserved", () => {
    const { events } = translateAttachFrame(attachBridgeInitial(S), {
      t: "event",
      seq: 5,
      kind: "state_changed",
      payload: { state: "awaiting_approval" },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "STATE_DELTA",
        seq: 5,
        ops: [{ op: "replace", path: "/state", value: "awaiting_approval" }],
      }),
    ]);
  });

  it("maps cost_sample and approval_requested to their typed CUSTOM lanes", () => {
    const cost = translateAttachFrame(attachBridgeInitial(S), {
      t: "event",
      seq: 6,
      kind: "cost_sample",
      payload: { tokens: 800 },
    }).events[0]!;
    expect(cost).toMatchObject({ type: "CUSTOM", name: "cost", seq: 6, value: { tokens: 800 } });

    const approval = translateAttachFrame(attachBridgeInitial(S), {
      t: "event",
      seq: 7,
      kind: "approval_requested",
      ref: "apr_1",
      payload: { requestId: "apr_1", tool: "bash", reason: "wants to deploy" },
    }).events[0]!;
    expect(approval).toMatchObject({ type: "CUSTOM", name: "approval", seq: 7 });
    expect(approval.value).toMatchObject({ requestId: "apr_1", tool: "bash", ref: "apr_1" });
  });

  it("rides tool-shaped events on the shared TOOL_CALL lanes", () => {
    const frames: AttachV1Frame[] = [
      { t: "event", seq: 8, kind: "tool_step", payload: { id: "tu_1", name: "bash", phase: "call", summary: "npm test" } },
      { t: "event", seq: 9, kind: "tool_step", payload: { id: "tu_1", name: "bash", phase: "result", summary: "72 passed" } },
    ];
    const { events } = translateAttachFrames(attachBridgeInitial(S), frames);
    expect(events.map((e) => e.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]);
    expect(events[0]).toMatchObject({ toolCallId: "tu_1", toolCallName: "bash", seq: 8 });
    expect(events[3]).toMatchObject({ toolCallId: "tu_1", content: "72 passed", seq: 9 });
  });

  it("degrades unknown kinds to a plane-honest activity event (risks R7)", () => {
    const { events } = translateAttachFrame(attachBridgeInitial(S), {
      t: "event",
      seq: 10,
      kind: "status_asserted",
      at: "2026-07-21T09:00:00Z",
      payload: { note: "checkpoint" },
    });
    expect(events[0]).toMatchObject({
      type: "CUSTOM",
      name: "activity",
      seq: 10,
      value: { kind: "status_asserted", payload: { note: "checkpoint" } },
    });
  });

  it("streams transcript deltas one message per turn, closing across turns", () => {
    const frames: AttachV1Frame[] = [
      { t: "delta", turn: 1, text: "Reading " },
      { t: "delta", turn: 1, text: "the repo…" },
      { t: "delta", turn: 2, text: "Now testing." },
      { t: "bye" },
    ];
    const { events } = translateAttachFrames(attachBridgeInitial(S), frames);
    expect(events.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "CUSTOM",
    ]);
    expect(events[0]!.messageId).toBe(`${S}:t1`);
    expect(events[4]!.messageId).toBe(`${S}:t2`);
    expect(events[7]!.name).toBe("bye");
  });

  it("maps protocol errors to RUN_ERROR and ignores live/ack/ping", () => {
    const err = translateAttachFrame(attachBridgeInitial(S), { t: "error", code: "version", message: "unsupported" }).events[0]!;
    expect(err).toMatchObject({ type: "RUN_ERROR", code: "version" });
    for (const t of ["live", "ack", "ping", "future_frame"]) {
      expect(translateAttachFrame(attachBridgeInitial(S), { t }).events).toEqual([]);
    }
  });

  it("reports presence for the lens's heads chip", () => {
    const { events } = translateAttachFrame(attachBridgeInitial(S), {
      t: "presence",
      heads: [{ principal: "usr_a", surface: "console" }],
    });
    expect(events[0]).toMatchObject({ type: "CUSTOM", name: "presence" });
  });
});
