// The Bridge, chat dialect (saas-copilot-surface CX0, design §1.2):
// recorded chat-v1 frame sequences translate to the exact expected AG-UI
// event sequences; seq/cursor is preserved through translation; unknown
// frames are ignored. Same seq, same cursor, no second truth.

import { chatBridgeInitial, translateChatFrame, translateChatFrames, type ChatV1Frame } from "@chat-worker/agui";
import { AGUI_DIALECT_VERSION, CLIENT_TOOLS_V1, validClientTools } from "@saas/contracts/agui";

const T = "chat_1";

/** A full recorded turn: start → deltas → tool call/result → durable
 * assistant msg → done (the chat-thread.ts emission order). */
const FULL_TURN: ChatV1Frame[] = [
  { t: "turn", phase: "start" },
  { t: "delta", text: "Looking " },
  { t: "delta", text: "at work…" },
  { t: "msg", seq: 4, role: "tool", text: "", tool: { name: "work_query", phase: "call", summary: "{\"filter\":\"ready\"}" } },
  { t: "msg", seq: 5, role: "tool", text: "", tool: { name: "work_query", phase: "result", summary: "2 items" } },
  { t: "delta", text: "Two items are ready." },
  { t: "msg", seq: 6, role: "assistant", text: "Looking at work… Two items are ready.", at: "2026-07-21T09:00:00Z", usage: { inputTokens: 100, outputTokens: 20 } },
  { t: "turn", phase: "done" },
];

describe("CX0: chat-v1 → AG-UI (the full-turn fixture)", () => {
  it("translates the canonical turn to the exact event sequence", () => {
    const { events } = translateChatFrames(chatBridgeInitial(T), FULL_TURN);
    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      // the tool round closes the streamed message (the client fold clears
      // its buffer on every durable msg; the bridge mirrors it)
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "MESSAGES_SNAPSHOT",
      "RUN_FINISHED",
    ]);
    // Every event speaks the pinned dialect.
    for (const e of events) expect(e.v).toBe(AGUI_DIALECT_VERSION);
  });

  it("derives the run id from the thread and threads it through RUN_*", () => {
    const { events } = translateChatFrames(chatBridgeInitial(T), FULL_TURN);
    const started = events.find((e) => e.type === "RUN_STARTED")!;
    const finished = events.find((e) => e.type === "RUN_FINISHED")!;
    expect(started.threadId).toBe(T);
    expect(started.runId).toBe(`${T}:r1`);
    expect(finished.runId).toBe(`${T}:r1`);
  });

  it("honors a door-supplied run id (run door, design §2.1)", () => {
    const { events } = translateChatFrames(chatBridgeInitial(T, "run_abc"), FULL_TURN);
    expect(events.find((e) => e.type === "RUN_STARTED")!.runId).toBe("run_abc");
  });

  it("preserves seq through translation (the dedupe watermark)", () => {
    const { events } = translateChatFrames(chatBridgeInitial(T), FULL_TURN);
    expect(events.find((e) => e.type === "TOOL_CALL_START")!.seq).toBe(4);
    expect(events.find((e) => e.type === "TOOL_CALL_RESULT")!.seq).toBe(5);
    expect(events.find((e) => e.type === "MESSAGES_SNAPSHOT")!.seq).toBe(6);
  });

  it("matches a tool result to its open call by name on legacy id-less frames", () => {
    const { events } = translateChatFrames(chatBridgeInitial(T), FULL_TURN);
    const start = events.find((e) => e.type === "TOOL_CALL_START")!;
    const result = events.find((e) => e.type === "TOOL_CALL_RESULT")!;
    expect(start.toolCallId).toBe(result.toolCallId);
    expect(start.toolCallName).toBe("work_query");
  });

  it("uses the loop's tool_use id verbatim when the frame threads it", () => {
    const frames: ChatV1Frame[] = [
      { t: "turn", phase: "start" },
      { t: "msg", seq: 2, role: "tool", toolId: "toolu_9", tool: { name: "work_query", phase: "call", summary: "{}" } },
      { t: "msg", seq: 3, role: "tool", toolId: "toolu_9", tool: { name: "work_query", phase: "result", summary: "ok" } },
      { t: "turn", phase: "done" },
    ];
    const { events } = translateChatFrames(chatBridgeInitial(T), frames);
    expect(events.find((e) => e.type === "TOOL_CALL_START")!.toolCallId).toBe("toolu_9");
    expect(events.find((e) => e.type === "TOOL_CALL_RESULT")!.toolCallId).toBe("toolu_9");
  });

  it("carries the durable row on the append-only snapshot increment", () => {
    const { events } = translateChatFrames(chatBridgeInitial(T), FULL_TURN);
    const snap = events.find((e) => e.type === "MESSAGES_SNAPSHOT")!;
    expect(snap.append).toBe(true);
    expect(snap.messages).toHaveLength(1);
    expect(snap.messages![0]).toMatchObject({ seq: 6, role: "assistant", usage: { outputTokens: 20 } });
  });
});

describe("CX0: the error turn and refusals", () => {
  it("maps the honest error turn to RUN_ERROR, closed by the turn frame", () => {
    const frames: ChatV1Frame[] = [
      { t: "turn", phase: "start" },
      { t: "msg", seq: 9, role: "assistant", error: true, text: "The dispatch model key didn't resolve" },
      { t: "turn", phase: "done" },
    ];
    const { events } = translateChatFrames(chatBridgeInitial(T), frames);
    expect(events.map((e) => e.type)).toEqual(["RUN_STARTED", "RUN_ERROR", "MESSAGES_SNAPSHOT", "RUN_FINISHED"]);
    expect(events[1]!.message).toContain("didn't resolve");
    expect(events[1]!.seq).toBe(9);
  });

  it("closes a dangling streamed message before RUN_FINISHED (crash-safety)", () => {
    const frames: ChatV1Frame[] = [
      { t: "turn", phase: "start" },
      { t: "delta", text: "half a thou" },
      { t: "turn", phase: "done" },
    ];
    const { events } = translateChatFrames(chatBridgeInitial(T), frames);
    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });
});

describe("CX0: watch-door frames and forward compatibility", () => {
  it("maps hello to a STATE_SNAPSHOT with the resume watermark", () => {
    const { events } = translateChatFrame(chatBridgeInitial(T), { t: "hello", title: "Ship ORN-142", latestSeq: 41 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "STATE_SNAPSHOT", snapshot: { threadId: T, title: "Ship ORN-142", cursor: 41 } });
  });

  it("ignores live/bye and unknown frame types", () => {
    const s = chatBridgeInitial(T);
    for (const t of ["live", "bye", "definitely_new_frame"]) {
      expect(translateChatFrame(s, { t }).events).toEqual([]);
    }
  });

  it("replayed durable rows (watch resume) become snapshot increments without a run", () => {
    const { events } = translateChatFrames(chatBridgeInitial(T), [
      { t: "msg", seq: 1, role: "user", text: "hi", principal: "usr_a" },
      { t: "msg", seq: 2, role: "assistant", text: "hello" },
    ]);
    expect(events.map((e) => e.type)).toEqual(["MESSAGES_SNAPSHOT", "MESSAGES_SNAPSHOT"]);
    expect(events[0]!.messages![0]).toMatchObject({ seq: 1, role: "user", principal: "usr_a" });
  });
});

describe("CX0: the client-tool registry (contracts)", () => {
  it("pins the six v1 verbs — prefill never submit, open never approve", () => {
    expect(CLIENT_TOOLS_V1.map((t) => t.name)).toEqual([
      "ui_navigate",
      "ui_open_work_item",
      "ui_open_session",
      "ui_prefill_spawn",
      "ui_copy",
      "ui_highlight_situation",
    ]);
    // Every verb is a ui_ verb, and none submits, approves, or destroys —
    // ui_prefill_spawn PREFILLS the form; the submit stays human.
    for (const t of CLIENT_TOOLS_V1) {
      expect(t.name).toMatch(/^ui_/);
      expect(t.name).not.toMatch(/submit|approve|delete|destroy/);
    }
  });

  it("validates advertised tools against the registry (free-form rejected)", () => {
    expect(validClientTools(undefined)).toBe(true);
    expect(validClientTools([{ name: "ui_navigate" }])).toBe(true);
    expect(validClientTools([{ name: "ui_navigate" }, { name: "run_shell" }])).toBe(false);
  });
});
