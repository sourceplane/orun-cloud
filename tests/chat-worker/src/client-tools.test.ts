// Client tools (saas-copilot-surface CX2, design §3): the broker pauses the
// tool round until the browser posts the id-matched result (single-use), the
// timeout synthesizes an error result so a closed laptop never wedges a
// thread, and the executor seam routes client verbs to the broker while
// server tools flow to the owner-credentialed executor untouched. Driven
// end-to-end over the REAL ChatThread with a scripted model.

import { ChatThread, type ChatStorage, type ModelClient, type ModelTurnResult, type ToolExecutor } from "@chat-worker/chat-thread";
import { createClientToolBroker, withClientTools } from "@chat-worker/client-tools";
import { aguiRunDoor } from "@chat-worker/agui-doors";
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
      if (text) onDelta(text);
      return next;
    },
  };
}

function serverTools(executed: string[]): ToolExecutor {
  return {
    specs: () => [{ name: "work_query", description: "query work", inputSchema: { type: "object" } }],
    execute: async (name) => {
      executed.push(name);
      return { summary: "server result", data: { ok: true } };
    },
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

describe("CX2: the broker", () => {
  it("serves registry specs for advertised verbs only (never the client's copy)", () => {
    const broker = createClientToolBroker([
      { name: "ui_navigate", description: "MALICIOUS OVERRIDE", parameters: { type: "object", properties: { evil: {} } } },
    ]);
    const specs = broker.specs();
    expect(specs).toHaveLength(1);
    expect(specs[0]!.name).toBe("ui_navigate");
    // The registry's description, not the head's.
    expect(specs[0]!.description).not.toContain("MALICIOUS");
    expect(broker.has("ui_navigate")).toBe(true);
    expect(broker.has("ui_copy")).toBe(false);
  });

  it("resolves an awaited call by id, single-use; unknown ids are refused", async () => {
    const broker = createClientToolBroker([{ name: "ui_copy" }], { timeoutMs: 5000 });
    const p = broker.awaitResult("tu_1");
    expect(broker.pending()).toEqual(["tu_1"]);
    expect(broker.resolve("tu_wrong", "x")).toBe(false);
    expect(broker.resolve("tu_1", "copied")).toBe(true);
    expect(broker.resolve("tu_1", "again")).toBe(false); // single-use
    const r = await p;
    expect(r).toMatchObject({ summary: "copied" });
    expect(broker.pending()).toEqual([]);
  });

  it("synthesizes client_timeout so the loop always proceeds", async () => {
    const broker = createClientToolBroker([{ name: "ui_copy" }], { timeoutMs: 20 });
    const r = await broker.awaitResult("tu_slow");
    expect(r.isError).toBe(true);
    expect(r.summary).toContain("client_timeout");
  });
});

describe("CX2: the paused turn (end-to-end over the run door)", () => {
  it("pauses on the client call, resumes on the posted result, embeds it", async () => {
    const thread = await freshThread();
    const executed: string[] = [];
    const broker = createClientToolBroker([{ name: "ui_open_work_item" }], { timeoutMs: 5000 });
    const tools = withClientTools(serverTools(executed), broker);
    const model = scriptedModel([
      { blocks: [{ type: "tool_use", id: "tu_9", name: "ui_open_work_item", input: { key: "ORN-142" } }], stopReason: "tool_use" },
      { blocks: [{ type: "text", text: "Opened ORN-142 for you." }], stopReason: "end_turn" },
    ]);

    const res = aguiRunDoor(thread, "ch_1", "run_1", () =>
      thread.runTurn("open ORN-142", "usr_a", {
        resolveModel: async () => model,
        tools,
        system: "sys",
        now: () => new Date("2026-07-21T09:00:00Z"),
      }),
    );

    // The browser sees the call and posts the result (the loop is paused
    // until this happens — poll the broker like the real post-back route).
    await new Promise<void>((resolveWait) => {
      const tick = () => {
        if (broker.pending().includes("tu_9")) {
          expect(broker.resolve("tu_9", "opened ORN-142")).toBe(true);
          resolveWait();
        } else setTimeout(tick, 5);
      };
      tick();
    });

    const events = parseSSE(await res.text());
    const types = events.map((e) => e.type);
    expect(types).toContain("TOOL_CALL_START");
    // The loop's tool_use id rides the stream verbatim (CX2 threads it).
    expect(events.find((e) => e.type === "TOOL_CALL_START")!.toolCallId).toBe("tu_9");
    expect(events.find((e) => e.type === "TOOL_CALL_RESULT")!.content).toBe("opened ORN-142");
    expect(types[types.length - 1]).toBe("RUN_FINISHED");
    // The server executor never saw the client verb.
    expect(executed).toEqual([]);
  });

  it("the timeout path completes the turn with the synthesized error result", async () => {
    const thread = await freshThread();
    const broker = createClientToolBroker([{ name: "ui_copy" }], { timeoutMs: 20 });
    const tools = withClientTools(serverTools([]), broker);
    const model = scriptedModel([
      { blocks: [{ type: "tool_use", id: "tu_1", name: "ui_copy", input: { text: "x" } }], stopReason: "tool_use" },
      { blocks: [{ type: "text", text: "Couldn't reach your browser." }], stopReason: "end_turn" },
    ]);

    const res = aguiRunDoor(thread, "ch_1", "run_2", () =>
      thread.runTurn("copy it", "usr_a", {
        resolveModel: async () => model,
        tools,
        system: "sys",
        now: () => new Date("2026-07-21T09:00:00Z"),
      }),
    );
    const events = parseSSE(await res.text());
    const result = events.find((e) => e.type === "TOOL_CALL_RESULT")!;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("client_timeout");
    expect(events[events.length - 1]!.type).toBe("RUN_FINISHED");
  });

  it("server tools still flow to the owner executor through the seam", async () => {
    const thread = await freshThread();
    const executed: string[] = [];
    const broker = createClientToolBroker([{ name: "ui_copy" }], { timeoutMs: 5000 });
    const tools = withClientTools(serverTools(executed), broker);
    const model = scriptedModel([
      { blocks: [{ type: "tool_use", id: "tu_2", name: "work_query", input: {} }], stopReason: "tool_use" },
      { blocks: [{ type: "text", text: "Done." }], stopReason: "end_turn" },
    ]);
    const r = await thread.runTurn("q", "usr_a", {
      resolveModel: async () => model,
      tools,
      system: "sys",
      now: () => new Date("2026-07-21T09:00:00Z"),
    });
    expect(r.ok).toBe(true);
    expect(executed).toEqual(["work_query"]);
    // The merged roster advertises both surfaces.
    expect(tools.specs().map((s) => s.name).sort()).toEqual(["ui_copy", "work_query"]);
  });
});
