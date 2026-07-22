// The copilot layer's pure seams (saas-copilot-surface CX3): the SSE parser,
// the dialect→stock event mapping (append-increments never reach the
// engine), the client-call tracker feeding the CX2 side channel, the six
// action handlers (prefill never submit, open never approve, org-scoped
// navigation only), and the thread's engine-event fold.

import { createSSEParser, mapDoorEvent, createClientCallTracker } from "@web-console-next/components/copilot/door-events";
import { buildActionHandlers, safeRoute, type ConsoleSurface } from "@web-console-next/components/copilot/actions";
import { foldEngineEvent, historyToItems } from "@web-console-next/components/copilot/copilot-thread";
import { translateChatFrame, chatBridgeInitial } from "@saas/contracts/agui-bridge";
import type { AguiEvent } from "@saas/contracts/agui";

describe("CX3: the SSE parser", () => {
  it("reassembles events across torn chunks", () => {
    const p = createSSEParser();
    expect(p.push('data: {"v":1,"type":"RUN_')).toEqual([]);
    const events = p.push('STARTED","runId":"r1"}\n\ndata: {"v":1,"type":"RUN_FINISHED"}\n\n');
    expect(events.map((e) => e.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
  });

  it("drops malformed events without killing the stream", () => {
    const p = createSSEParser();
    expect(p.push("data: {broken\n\ndata: {\"v\":1,\"type\":\"RUN_FINISHED\"}\n\n").map((e) => e.type)).toEqual(["RUN_FINISHED"]);
  });
});

describe("CX3: dialect → stock mapping", () => {
  it("passes the shared vocabulary and drops dialect-only increments", () => {
    const snap: AguiEvent = { v: 1, type: "MESSAGES_SNAPSHOT", append: true, messages: [{ seq: 1, role: "user", text: "x" }] };
    expect(mapDoorEvent(snap)).toEqual([]);
    expect(mapDoorEvent({ v: 1, type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hi" })).toHaveLength(1);
  });

  it("completes TOOL_CALL_RESULT with the messageId stock schemas require", () => {
    const [e] = mapDoorEvent({ v: 1, type: "TOOL_CALL_RESULT", toolCallId: "tu_1", content: "ok" });
    expect(e).toMatchObject({ messageId: "result:tu_1" });
  });
});

describe("CX3: the client-call tracker (the CX2 side channel's eyes)", () => {
  it("reports a completed REGISTRY call with parsed input", () => {
    const t = createClientCallTracker();
    expect(t.fold({ v: 1, type: "TOOL_CALL_START", toolCallId: "tu_1", toolCallName: "ui_open_work_item" })).toBeNull();
    expect(t.fold({ v: 1, type: "TOOL_CALL_ARGS", toolCallId: "tu_1", delta: '{"key":"ORN-142"}' })).toBeNull();
    expect(t.fold({ v: 1, type: "TOOL_CALL_END", toolCallId: "tu_1" })).toEqual({
      toolCallId: "tu_1",
      name: "ui_open_work_item",
      input: { key: "ORN-142" },
    });
  });

  it("ignores server tools — only registry verbs are client calls", () => {
    const t = createClientCallTracker();
    expect(t.fold({ v: 1, type: "TOOL_CALL_START", toolCallId: "tu_2", toolCallName: "work_query" })).toBeNull();
    expect(t.fold({ v: 1, type: "TOOL_CALL_END", toolCallId: "tu_2" })).toBeNull();
  });
});

describe("CX3: the action handlers (§3.2 review bar)", () => {
  function surface(): ConsoleSurface & { pushed: string[]; copied: string[] } {
    const s = {
      pushed: [] as string[],
      copied: [] as string[],
      orgSlug: "acme",
      push(r: string) {
        s.pushed.push(r);
      },
      async copy(t: string) {
        s.copied.push(t);
      },
    };
    return s;
  }

  it("navigates only org-scoped console routes", async () => {
    const s = surface();
    const h = buildActionHandlers(s);
    expect(await h.ui_navigate!({ route: "/work" })).toContain("/orgs/acme/work");
    expect(await h.ui_navigate!({ route: "https://evil.example" })).toContain("refused");
    expect(await h.ui_navigate!({ route: "//evil.example" })).toContain("refused");
    expect(s.pushed).toEqual(["/orgs/acme/work"]);
    expect(safeRoute("acme", "/orgs/acme/dispatch")).toBe("/orgs/acme/dispatch");
  });

  it("prefills the spawn form — never submits", async () => {
    const s = surface();
    const h = buildActionHandlers(s);
    const out = await h.ui_prefill_spawn!({ taskKey: "ORN-142", profileId: "agp_1" });
    expect(out).toContain("prefilled");
    expect(s.pushed[0]).toContain("spawn=1");
    expect(s.pushed[0]).toContain("task=ORN-142");
    // No handler name submits, approves, or spawns directly.
    expect(Object.keys(h).every((n) => n.startsWith("ui_"))).toBe(true);
  });

  it("opens work items and sessions by id, copies text", async () => {
    const s = surface();
    const h = buildActionHandlers(s);
    await h.ui_open_work_item!({ key: "ORN-9" });
    await h.ui_open_session!({ id: "as_1" });
    await h.ui_copy!({ text: "hello" });
    expect(s.pushed).toEqual(["/orgs/acme/work?item=ORN-9", "/orgs/acme/agents/as_1"]);
    expect(s.copied).toEqual(["hello"]);
  });

  it("DD7: a surface without a highlight capability builds NO highlight handler", async () => {
    const bare = buildActionHandlers(surface());
    expect(bare.ui_highlight_situation).toBeUndefined();
    const highlighted: string[] = [];
    const rich = buildActionHandlers({ ...surface(), highlight: (sec: string) => highlighted.push(sec) });
    expect(await rich.ui_highlight_situation!({ section: "nope" })).toContain("refused");
    expect(await rich.ui_highlight_situation!({ section: "inFlight" })).toContain("highlighted");
    expect(highlighted).toEqual(["inFlight"]);
  });
});

describe("CX3/DD2: the thread's engine-event fold (single transcript)", () => {
  const init = { items: [], streaming: "", running: false, error: null };

  it("streams text into a bubble closed by TEXT_MESSAGE_END", () => {
    let s = foldEngineEvent(init, { type: "RUN_STARTED" });
    s = foldEngineEvent(s, { type: "TEXT_MESSAGE_CONTENT", delta: "Hel" });
    s = foldEngineEvent(s, { type: "TEXT_MESSAGE_CONTENT", delta: "lo" });
    expect(s.streaming).toBe("Hello");
    s = foldEngineEvent(s, { type: "TEXT_MESSAGE_END", messageId: "m1" });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "assistant", text: "Hello" });
    s = foldEngineEvent(s, { type: "RUN_FINISHED" });
    expect(s.running).toBe(false);
  });

  it("renders tool lifecycles in arrival order and marks client verbs as chips", () => {
    let s = foldEngineEvent(init, { type: "TOOL_CALL_START", toolCallId: "tu_1", toolCallName: "ui_copy" });
    expect(s.items[0]).toMatchObject({ kind: "tool", tool: { client: true } });
    s = foldEngineEvent(s, { type: "TOOL_CALL_START", toolCallId: "tu_2", toolCallName: "work_query" });
    expect(s.items[1]).toMatchObject({ kind: "tool", tool: { client: false } });
    s = foldEngineEvent(s, { type: "TOOL_CALL_RESULT", toolCallId: "tu_2", content: "2 items" });
    expect(s.items[1]).toMatchObject({ kind: "tool", tool: { result: "2 items" } });
  });

  it("DD2: final text renders AFTER the tool cards that produced it — arrival order, no regrouping", () => {
    let s = foldEngineEvent(init, { type: "RUN_STARTED" });
    s = foldEngineEvent(s, { type: "TOOL_CALL_START", toolCallId: "tu_1", toolCallName: "runs_list" });
    s = foldEngineEvent(s, { type: "TOOL_CALL_RESULT", toolCallId: "tu_1", content: "1 failed run" });
    s = foldEngineEvent(s, { type: "TEXT_MESSAGE_CONTENT", delta: "One run failed overnight." });
    s = foldEngineEvent(s, { type: "TEXT_MESSAGE_END", messageId: "m1" });
    expect(s.items.map((it) => it.kind)).toEqual(["tool", "assistant"]);
  });

  it("DD6: RUN_ERROR is a durable transcript item, not only a banner", () => {
    const s = foldEngineEvent({ ...init, running: true }, { type: "RUN_ERROR", code: "turn_in_progress", message: "busy" });
    expect(s).toMatchObject({ running: false, error: "busy" });
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: "error", text: "busy" });
  });

  it("DD2: a dangling stream survives RUN_FINISHED as a bubble", () => {
    let s = foldEngineEvent(init, { type: "TEXT_MESSAGE_CONTENT", delta: "partial answer" });
    s = foldEngineEvent(s, { type: "RUN_FINISHED" });
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: "assistant", text: "partial answer" });
    expect(s.streaming).toBe("");
  });
});

describe("DD2: history reconstruction (historyToItems)", () => {
  it("preserves tool cards, pairs call+result, and never orphans a user message", () => {
    const items = historyToItems([
      { seq: 0, role: "user", text: "what broke?" },
      { seq: 1, role: "tool", text: "", tool: { name: "runs_list", phase: "call", summary: "{}" } },
      { seq: 2, role: "tool", text: "", tool: { name: "runs_list", phase: "result", summary: "1 failed" } },
      { seq: 3, role: "assistant", text: "One run failed." },
      { seq: 4, role: "user", text: "and then?" },
      { seq: 5, role: "assistant", text: "" }, // empty-text turn — must NOT vanish
    ]);
    expect(items.map((it) => it.kind)).toEqual(["user", "tool", "assistant", "user", "note"]);
    expect(items[1]).toMatchObject({ kind: "tool", tool: { name: "runs_list", result: "1 failed" } });
  });
});

describe("DD1: client tools execute at the call phase (deadlock regression)", () => {
  it("the browser tracker completes a client call from the server's CALL-phase frames alone", () => {
    // The server loop is PAUSED inside execute() awaiting the browser's
    // post-back — so the result-phase frames cannot exist yet. The tracker
    // must fire from what the call phase emits, or every client tool burns
    // the 60s client_timeout (the shipped deadlock).
    let state = chatBridgeInitial("ch_1");
    ({ state } = translateChatFrame(state, { t: "turn", phase: "start" }));
    const { state: s2, events } = translateChatFrame(state, {
      t: "msg",
      seq: 3,
      role: "tool",
      text: "",
      tool: { name: "ui_highlight_situation", phase: "call", summary: '{"section":"inFlight"}' },
      toolId: "tu_9",
    });
    state = s2;
    const tracker = createClientCallTracker();
    let completed: ReturnType<typeof tracker.fold> = null;
    for (const e of events) {
      const c = tracker.fold(e);
      if (c) completed = c;
    }
    expect(completed).toEqual({
      toolCallId: "tu_9",
      name: "ui_highlight_situation",
      input: { section: "inFlight" },
    });
  });

  it("server tools still close at the result phase — no double END for either kind", () => {
    let state = chatBridgeInitial("ch_1");
    ({ state } = translateChatFrame(state, { t: "turn", phase: "start" }));
    // Server tool: END must NOT appear at call phase…
    const call = translateChatFrame(state, {
      t: "msg", seq: 1, role: "tool", text: "",
      tool: { name: "runs_list", phase: "call", summary: "{}" }, toolId: "tu_1",
    });
    expect(call.events.map((e) => e.type)).not.toContain("TOOL_CALL_END");
    // …and appears exactly once at result phase.
    const res = translateChatFrame(call.state, {
      t: "msg", seq: 2, role: "tool", text: "",
      tool: { name: "runs_list", phase: "result", summary: "ok" }, toolId: "tu_1",
    });
    expect(res.events.filter((e) => e.type === "TOOL_CALL_END")).toHaveLength(1);
    // Client tool: END at call phase, absent at result phase.
    const ccall = translateChatFrame(res.state, {
      t: "msg", seq: 3, role: "tool", text: "",
      tool: { name: "ui_copy", phase: "call", summary: '{"text":"x"}' }, toolId: "tu_2",
    });
    expect(ccall.events.filter((e) => e.type === "TOOL_CALL_END")).toHaveLength(1);
    const cres = translateChatFrame(ccall.state, {
      t: "msg", seq: 4, role: "tool", text: "",
      tool: { name: "ui_copy", phase: "result", summary: "copied" }, toolId: "tu_2",
    });
    expect(cres.events.map((e) => e.type)).not.toContain("TOOL_CALL_END");
    expect(cres.events.map((e) => e.type)).toContain("TOOL_CALL_RESULT");
  });
});
