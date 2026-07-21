// The copilot layer's pure seams (saas-copilot-surface CX3): the SSE parser,
// the dialect→stock event mapping (append-increments never reach the
// engine), the client-call tracker feeding the CX2 side channel, the six
// action handlers (prefill never submit, open never approve, org-scoped
// navigation only), and the thread's engine-event fold.

import { createSSEParser, mapDoorEvent, createClientCallTracker } from "@web-console-next/components/copilot/door-events";
import { buildActionHandlers, safeRoute, type ConsoleSurface } from "@web-console-next/components/copilot/actions";
import { foldEngineEvent } from "@web-console-next/components/copilot/copilot-thread";
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
    expect(await h.ui_highlight_situation!({ section: "nope" })).toContain("refused");
  });
});

describe("CX3: the thread's engine-event fold", () => {
  const init = { messages: [], tools: [], streaming: "", running: false, error: null };

  it("streams text into a bubble closed by TEXT_MESSAGE_END", () => {
    let s = foldEngineEvent(init, { type: "RUN_STARTED" });
    s = foldEngineEvent(s, { type: "TEXT_MESSAGE_CONTENT", delta: "Hel" });
    s = foldEngineEvent(s, { type: "TEXT_MESSAGE_CONTENT", delta: "lo" });
    expect(s.streaming).toBe("Hello");
    s = foldEngineEvent(s, { type: "TEXT_MESSAGE_END", messageId: "m1" });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: "assistant", text: "Hello" });
    s = foldEngineEvent(s, { type: "RUN_FINISHED" });
    expect(s.running).toBe(false);
  });

  it("renders tool lifecycles and marks client verbs as chips", () => {
    let s = foldEngineEvent(init, { type: "TOOL_CALL_START", toolCallId: "tu_1", toolCallName: "ui_copy" });
    expect(s.tools[0]).toMatchObject({ client: true });
    s = foldEngineEvent(s, { type: "TOOL_CALL_START", toolCallId: "tu_2", toolCallName: "work_query" });
    expect(s.tools[1]).toMatchObject({ client: false });
    s = foldEngineEvent(s, { type: "TOOL_CALL_RESULT", toolCallId: "tu_2", content: "2 items" });
    expect(s.tools[1]).toMatchObject({ result: "2 items" });
  });

  it("surfaces RUN_ERROR honestly and stops running", () => {
    const s = foldEngineEvent({ ...init, running: true }, { type: "RUN_ERROR", code: "turn_in_progress", message: "busy" });
    expect(s).toMatchObject({ running: false, error: "busy" });
  });
});
