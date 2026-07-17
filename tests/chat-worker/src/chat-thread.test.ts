// AN4 (saas-agents-native): the Workspace Agent's conversation core, driven
// with RECORDED-MODEL fixtures (a scripted ModelClient — no network, no key).
// Pins: durable turn folding, live delta fan-out, tool rounds with visible
// cards, the honest custody-failure error turn, mid-stream resume by a
// second head, and the immutable workspace binding.

import {
  ChatThread,
  type ChatStorage,
  type ConnectionLike,
  type ModelClient,
  type ModelTurnResult,
  type ToolExecutor,
} from "@chat-worker/chat-thread";

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

function fakeConn(id: string): ConnectionLike & { sent: string[] } {
  const conn = {
    id,
    sent: [] as string[],
    connState: null as unknown,
    send(msg: string) {
      conn.sent.push(msg);
    },
    close() {
      /* no-op */
    },
    setState(s: unknown) {
      conn.connState = s;
    },
    get state() {
      return conn.connState;
    },
  };
  return conn;
}

/** A recorded-model fixture: each call pops the next scripted result and
 * streams its text as two deltas. */
function scriptedModel(turns: ModelTurnResult[]): ModelClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async stream(req, onDelta) {
      calls.push(req);
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

describe("AN4: the turn loop (recorded-model fixtures)", () => {
  it("folds a plain text turn: durable user + assistant messages, live deltas", async () => {
    const thread = await freshThread();
    const head = fakeConn("h1");
    thread.connect(head, -1);

    const model = scriptedModel([{ blocks: [{ type: "text", text: "2 sessions sealed overnight." }], stopReason: "end_turn" }]);
    const r = await thread.runTurn("what broke overnight?", "usr_rahul", {
      resolveModel: async () => model,
      tools: noTools(),
      system: "sys",
      now: () => new Date("2026-07-17T01:00:00Z"),
    });
    expect(r.ok).toBe(true);

    const history = thread.history();
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history[0]!.principal).toBe("usr_rahul");
    expect(history[1]!.text).toBe("2 sessions sealed overnight.");

    const frames = head.sent.map((s) => JSON.parse(s) as { t: string; text?: string; phase?: string });
    expect(frames.filter((f) => f.t === "delta").map((f) => f.text).join("")).toBe("2 sessions sealed overnight.");
    expect(frames.filter((f) => f.t === "msg")).toHaveLength(2);
    expect(frames.some((f) => f.t === "turn" && f.phase === "done")).toBe(true);
  });

  it("runs a tool round with visible call/result cards, then the final answer", async () => {
    const thread = await freshThread();
    const head = fakeConn("h1");
    thread.connect(head, -1);

    const model = scriptedModel([
      { blocks: [{ type: "tool_use", id: "tu_1", name: "runs_list", input: { limit: 3 } }], stopReason: "tool_use" },
      { blocks: [{ type: "text", text: "3 runs, all green." }], stopReason: "end_turn" },
    ]);
    const executed: string[] = [];
    const tools: ToolExecutor = {
      specs: () => [{ name: "runs_list", description: "list runs", inputSchema: { type: "object" } }],
      execute: async (name, input) => {
        executed.push(`${name}:${JSON.stringify(input)}`);
        return { summary: "3 runs", data: { runs: [1, 2, 3] } };
      },
    };
    const r = await thread.runTurn("how are the runs?", "usr_rahul", {
      resolveModel: async () => model,
      tools,
      system: "sys",
    });
    expect(r.ok).toBe(true);
    expect(executed).toEqual(['runs_list:{"limit":3}']);

    const roles = thread.history().map((m) => `${m.role}${m.tool ? ":" + m.tool.phase : ""}`);
    expect(roles).toEqual(["user", "tool:call", "tool:result", "assistant"]);
    expect(thread.history()[3]!.text).toBe("3 runs, all green.");
    // The tool round's results went back to the model as one user message.
    expect((model.calls[1] as { messages: unknown[] }).messages.length).toBeGreaterThan(
      (model.calls[0] as { messages: unknown[] }).messages.length,
    );
  });

  it("a custody failure is an honest, retryable error turn — never a hang", async () => {
    const thread = await freshThread();
    const r = await thread.runTurn("hello?", "usr_rahul", {
      resolveModel: async () => null, // the key did not resolve
      tools: noTools(),
      system: "sys",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("custody_failed");
    const last = thread.history().at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.error).toBe(true);
    expect(last.text).toContain("Anthropic connection");

    // Retryable: a later turn with custody restored succeeds.
    const model = scriptedModel([{ blocks: [{ type: "text", text: "back online." }], stopReason: "end_turn" }]);
    const r2 = await thread.runTurn("hello again?", "usr_rahul", {
      resolveModel: async () => model,
      tools: noTools(),
      system: "sys",
    });
    expect(r2.ok).toBe(true);
  });

  it("a model failure mid-turn lands as an error turn too", async () => {
    const thread = await freshThread();
    const model: ModelClient = {
      stream: async () => {
        throw new Error("api_error 529");
      },
    };
    const r = await thread.runTurn("hi", "usr_a", {
      resolveModel: async () => model,
      tools: noTools(),
      system: "sys",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("model_failed");
    expect(thread.history().at(-1)!.error).toBe(true);
  });

  it("a second head resumes the thread mid-stream (replay + live deltas)", async () => {
    const thread = await freshThread();
    const first = fakeConn("h1");
    thread.connect(first, -1);

    let second: ReturnType<typeof fakeConn> | null = null;
    const model: ModelClient = {
      async stream(_req, onDelta) {
        onDelta("first half ");
        // The second browser opens the thread while the turn is streaming.
        second = fakeConn("h2");
        thread.connect(second, thread.history().at(-1)!.seq);
        onDelta("second half");
        return { blocks: [{ type: "text", text: "first half second half" }], stopReason: "end_turn" };
      },
    };
    await thread.runTurn("stream it", "usr_a", {
      resolveModel: async () => model,
      tools: noTools(),
      system: "sys",
    });

    const secondFrames = (second as unknown as { sent: string[] }).sent.map((s) => JSON.parse(s) as { t: string; text?: string });
    // Replay gave it the user message it missed; live gave it the tail delta
    // and the durable assistant message.
    expect(secondFrames.some((f) => f.t === "msg")).toBe(true);
    expect(secondFrames.filter((f) => f.t === "delta").map((f) => f.text)).toEqual(["second half"]);
    // The durable assistant message lands after the tail delta (then the
    // turn-done marker closes the stream).
    const kinds = secondFrames.map((f) => f.t);
    expect(kinds.lastIndexOf("msg")).toBeGreaterThan(kinds.lastIndexOf("delta"));
  });

  it("refuses a concurrent turn (one voice per thread)", async () => {
    const thread = await freshThread();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const model: ModelClient = {
      async stream() {
        await gate;
        return { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    };
    const t1 = thread.runTurn("one", "usr_a", { resolveModel: async () => model, tools: noTools(), system: "s" });
    await new Promise((r) => setTimeout(r, 0));
    const r2 = await thread.runTurn("two", "usr_b", { resolveModel: async () => model, tools: noTools(), system: "s" });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("turn_in_progress");
    release();
    await t1;
  });
});

describe("AN4: the immutable workspace binding", () => {
  it("refuses re-binding to another workspace and org-mismatched reads", async () => {
    const thread = await freshThread();
    await expect(thread.init({ ...META, orgId: "org-uuid-OTHER" })).rejects.toThrow("bound to another workspace");
    expect(() => thread.assertOrg("org-uuid-OTHER")).toThrow("bound to another workspace");
    expect(() => thread.assertOrg(META.orgId)).not.toThrow();
  });

  it("history survives a reload (durable thread)", async () => {
    const storage = memStorage();
    const t1 = new ChatThread(storage);
    await t1.load();
    await t1.init(META);
    const model = scriptedModel([{ blocks: [{ type: "text", text: "persisted." }], stopReason: "end_turn" }]);
    await t1.runTurn("save this", "usr_a", { resolveModel: async () => model, tools: noTools(), system: "s" });

    const t2 = new ChatThread(storage);
    await t2.load();
    expect(t2.info()?.chatId).toBe("ch_1");
    expect(t2.history().map((m) => m.text)).toEqual(["save this", "persisted."]);
  });
});
