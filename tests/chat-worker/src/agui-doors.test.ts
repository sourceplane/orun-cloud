// The AG-UI doors (saas-copilot-surface CX1, design §2): end-to-end over the
// REAL ChatThread with a scripted model — the run door tees the normal turn
// loop into a valid AG-UI SSE stream ending in RUN_FINISHED; refusals speak
// in-dialect; the watch door replays from a cursor with no gap or duplicate
// against the WS fold; the relay's session watch door translates at source.

import { ChatThread, type ChatStorage, type ModelClient, type ModelTurnResult, type ToolExecutor } from "@chat-worker/chat-thread";
import { aguiRunDoor, aguiWatchDoor, encodeAguiSSE } from "@chat-worker/agui-doors";
import type { AguiEvent } from "@saas/contracts/agui";

function memStorage(): ChatStorage {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) {
      return m.get(k) as T | undefined;
    },
    async put<T>(k: string, v: T) {
      m.set(k, v);
    },
    async list<T>({ prefix }: { prefix: string }) {
      const out = new Map<string, T>();
      for (const [k, v] of m) if (k.startsWith(prefix)) out.set(k, v as T);
      return out;
    },
    async delete(k: string) {
      return m.delete(k);
    },
  };
}

function scriptedModel(turns: ModelTurnResult[]): ModelClient {
  return {
    async stream(_req, onDelta) {
      const next = turns.shift();
      if (!next) throw new Error("fixture exhausted");
      const text = next.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      if (text) {
        onDelta(text.slice(0, Math.ceil(text.length / 2)));
        onDelta(text.slice(Math.ceil(text.length / 2)));
      }
      return next;
    },
  };
}

function noTools(): ToolExecutor {
  return {
    specs: () => [],
    execute: async (name) => ({ summary: `no such tool ${name}`, data: {}, isError: true }),
  };
}

const META = { chatId: "ch_1", orgId: "org-uuid-1", title: "Test", createdAt: "2026-07-17T00:00:00Z" };

async function freshThread(): Promise<ChatThread> {
  const t = new ChatThread(memStorage());
  await t.load();
  await t.init(META);
  return t;
}

function parseSSE(text: string): AguiEvent[] {
  return text
    .split("\n\n")
    .filter((c) => c.startsWith("data: "))
    .map((c) => JSON.parse(c.slice(6)) as AguiEvent);
}

/** Read a streaming Response until `done` events or an abort closes it. */
async function readAll(res: Response): Promise<AguiEvent[]> {
  return parseSSE(await res.text());
}

describe("CX1: the run door (turn = run)", () => {
  it("tees a full turn into a valid AG-UI stream ending in RUN_FINISHED", async () => {
    const thread = await freshThread();
    const model = scriptedModel([{ blocks: [{ type: "text", text: "Two items are ready." }], stopReason: "end_turn" }]);

    const res = aguiRunDoor(thread, "ch_1", "run_1", () =>
      thread.runTurn("what's ready?", "usr_a", {
        resolveModel: async () => model,
        tools: noTools(),
        system: "sys",
        now: () => new Date("2026-07-21T09:00:00Z"),
      }),
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events = await readAll(res);
    const types = events.map((e) => e.type);
    // AG-UI verifier contract: the run stream MUST begin with RUN_STARTED (the
    // hello-derived STATE_SNAPSHOT is gated out) and end with RUN_FINISHED.
    expect(types[0]).toBe("RUN_STARTED");
    expect(types).not.toContain("STATE_SNAPSHOT");
    expect(types.filter((t) => t === "TEXT_MESSAGE_CONTENT").length).toBeGreaterThanOrEqual(2);
    expect(types[types.length - 1]).toBe("RUN_FINISHED");
    expect(events.find((e) => e.type === "RUN_STARTED")!.runId).toBe("run_1");
    // The streamed text reassembles exactly.
    expect(events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join("")).toBe("Two items are ready.");
    // The user row is fanned out BEFORE turn:start, so the gate drops its
    // snapshot too (it would else be a second pre-RUN_STARTED event; the
    // client already rendered the user bubble optimistically). Only the
    // assistant's durable row rides the stream, after RUN_STARTED.
    expect(events.filter((e) => e.type === "MESSAGES_SNAPSHOT")).toHaveLength(1);
    expect(events.find((e) => e.type === "MESSAGES_SNAPSHOT")!.messages![0]!.role).toBe("assistant");
    // The virtual head detached after the run.
    expect(thread.headCount()).toBe(0);
  });

  it("speaks a refusal in-dialect: RUN_ERROR {turn_in_progress} is first AND terminal", async () => {
    const thread = await freshThread();
    const res = aguiRunDoor(thread, "ch_1", "run_9", async () => ({ ok: false, reason: "turn_in_progress" }));
    const events = await readAll(res);
    // A refusal never runs the turn, so RUN_ERROR is the whole stream — valid
    // (RUN_ERROR may lead) and terminal (no RUN_FINISHED after it).
    expect(events.map((e) => e.type)).toEqual(["RUN_ERROR"]);
    expect(events[0]!.code).toBe("turn_in_progress");
    expect(thread.headCount()).toBe(0);
  });

  it("closes the stream even when the turn throws — RUN_ERROR, no RUN_FINISHED", async () => {
    const thread = await freshThread();
    const res = aguiRunDoor(thread, "ch_1", undefined, async () => {
      throw new Error("boom");
    });
    const events = await readAll(res);
    expect(events.find((e) => e.type === "RUN_ERROR")!.code).toBe("internal_error");
    expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(false);
    expect(thread.headCount()).toBe(0);
  });

  it("an error TURN ends at RUN_ERROR — the turn:done RUN_FINISHED is suppressed", async () => {
    const thread = await freshThread();
    // A model that resolves to no client → the honest custody error turn:
    // the loop emits turn:start (RUN_STARTED), the error msg (RUN_ERROR), then
    // turn:done (RUN_FINISHED) — the last must NOT reach the stream.
    const res = aguiRunDoor(thread, "ch_1", "run_e", () =>
      thread.runTurn("hi", "usr_a", {
        resolveModel: async () => null,
        tools: noTools(),
        system: "sys",
        now: () => new Date("2026-07-21T09:00:00Z"),
      }),
    );
    const events = await readAll(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("RUN_STARTED");
    expect(types[types.length - 1]).toBe("RUN_ERROR");
    expect(types).not.toContain("RUN_FINISHED");
  });
});

describe("CX1: the watch door (passive follower)", () => {
  it("replays history past the cursor, then lives; abort tears down", async () => {
    const thread = await freshThread();
    const model = scriptedModel([
      { blocks: [{ type: "text", text: "First answer." }], stopReason: "end_turn" },
      { blocks: [{ type: "text", text: "Second answer." }], stopReason: "end_turn" },
    ]);
    const deps = {
      resolveModel: async () => model,
      tools: noTools(),
      system: "sys",
      now: () => new Date("2026-07-21T09:00:00Z"),
    };
    await thread.runTurn("q1", "usr_a", deps);

    const ctrl = new AbortController();
    const res = aguiWatchDoor(thread, "ch_1", -1, ctrl.signal);
    // A live turn lands while the watcher is attached.
    await thread.runTurn("q2", "usr_a", deps);
    ctrl.abort();

    const events = await readAll(res);
    // Snapshot leads with the resume watermark (seq 1 = q1's assistant row).
    expect(events[0]!.type).toBe("STATE_SNAPSHOT");
    expect(events[0]!.snapshot).toMatchObject({ cursor: 1 });
    // Replayed durable rows: q1's user+assistant; then the LIVE run for q2.
    const snapshots = events.filter((e) => e.type === "MESSAGES_SNAPSHOT");
    expect(snapshots.map((s) => s.messages![0]!.seq)).toEqual([0, 1, 2, 3]);
    expect(events.some((e) => e.type === "RUN_STARTED")).toBe(true);
    expect(thread.headCount()).toBe(0);
  });

  it("resumes from a cursor with no duplicate (the ?from= contract)", async () => {
    const thread = await freshThread();
    const model = scriptedModel([{ blocks: [{ type: "text", text: "First answer." }], stopReason: "end_turn" }]);
    await thread.runTurn("q1", "usr_a", {
      resolveModel: async () => model,
      tools: noTools(),
      system: "sys",
      now: () => new Date("2026-07-21T09:00:00Z"),
    });

    const ctrl = new AbortController();
    const res = aguiWatchDoor(thread, "ch_1", 1, ctrl.signal);
    ctrl.abort();
    const events = await readAll(res);
    // Seqs 0 and 1 are behind the cursor — nothing replays but the snapshot.
    expect(events.filter((e) => e.type === "MESSAGES_SNAPSHOT")).toHaveLength(0);
  });
});

describe("CX1: SSE encoding", () => {
  it("frames one event per data line", () => {
    const line = encodeAguiSSE({ v: 1, type: "RUN_FINISHED" });
    expect(line).toBe('data: {"v":1,"type":"RUN_FINISHED"}\n\n');
  });
});
