import { RelayCore, type RelayStorage, type HeadSink } from "../../../apps/agents-worker/src/relay-core.js";
import {
  eventFrame,
  deltaFrame,
  steerFrame,
  verdictFrame,
  ackFrame,
  byeFrame,
  ATTACH_ACK_REASONS,
  type AttachFrame,
} from "@saas/contracts/agents-attach";

// memStorage is the in-memory DurableObjectStorage double (the jest seam).
function memStorage(): RelayStorage {
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

// collectSink records frames a head receives (the array-backed HeadSink).
function collectSink(id: string, principal = "usr_x", surface = "console"): HeadSink & { frames: AttachFrame[]; closed: boolean } {
  const frames: AttachFrame[] = [];
  const sink = {
    id,
    principal,
    surface,
    frames,
    closed: false,
    send(f: AttachFrame) {
      frames.push(f);
    },
    close() {
      sink.closed = true;
    },
  };
  return sink;
}

describe("RelayCore: attach replay → live", () => {
  it("serves hello, replay past the cursor, then live", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_relay1", runKind: "interactive" });
    await core.ingestEvents([
      eventFrame(0, "state_changed", "", { state: "running" }),
      eventFrame(1, "message_agent", "", { text: "reading brief" }),
      eventFrame(2, "tool_call", "", { tool: "catalog_affected", decision: "allow" }),
    ]);

    const h = collectSink("h1");
    core.attach(h, 0); // cursor 0: replay events with seq > 0

    expect(h.frames[0]!.t).toBe("hello");
    expect(h.frames[0]!.sessionId).toBe("as_relay1");
    expect(h.frames[0]!.latestSeq).toBe(2);
    // Replay skips seq 0 (cursor), includes 1 and 2, then live — presence
    // (advisory) may follow the live marker on attach.
    const spine = h.frames.filter((f) => f.t !== "presence").map((f) => `${f.t}:${f.kind ?? ""}`);
    expect(spine).toEqual(["hello:", "event:message_agent", "event:tool_call", "live:"]);
  });

  it("dedupes events by seq", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_dedupe" });
    expect(await core.ingestEvents([eventFrame(0, "message_agent", "", {})])).toBe(1);
    expect(await core.ingestEvents([eventFrame(0, "message_agent", "", {})])).toBe(0); // duplicate seq
    expect(await core.ingestEvents([eventFrame(1, "message_agent", "", {})])).toBe(1);
  });

  it("fans live events and deltas to every attached head", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_fan" });
    const a = collectSink("a", "usr_a");
    const b = collectSink("b", "usr_b");
    core.attach(a, -1);
    core.attach(b, -1);
    await core.ingestEvents([eventFrame(0, "message_agent", "", { text: "hi" })]);
    core.fanOutDelta(deltaFrame(1, "streaming…"));

    for (const s of [a, b]) {
      expect(s.frames.some((f) => f.t === "event" && f.payload?.text === "hi")).toBe(true);
      expect(s.frames.some((f) => f.t === "delta")).toBe(true);
    }
  });

  it("announces presence on attach and detach", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_pres" });
    const a = collectSink("a", "usr_a");
    core.attach(a, -1);
    const b = collectSink("b", "usr_b");
    core.attach(b, -1);
    // a saw a presence frame naming both heads.
    const pres = a.frames.filter((f) => f.t === "presence").pop();
    expect(pres?.heads?.map((h) => h.principal).sort()).toEqual(["usr_a", "usr_b"]);
    core.detach("b");
    const after = a.frames.filter((f) => f.t === "presence").pop();
    expect(after?.heads?.map((h) => h.principal)).toEqual(["usr_a"]);
  });
});

describe("RelayCore: the input return-queue", () => {
  it("edge-stamps the principal and resolves the head ack via the body", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_input" });
    // A head posts a steer; the body has not polled yet, so the ack is pending.
    const steerAck = core.enqueueInput(steerFrame("in-1", "hello"), "usr_alice");

    // The body long-polls and gets the input, principal-stamped.
    const { items, cursor } = core.pollInputs(0);
    expect(items).toHaveLength(1);
    expect(items[0]!.t).toBe("steer");
    expect(items[0]!.payload?.principal).toBe("usr_alice"); // edge-stamped
    expect(cursor).toBe(1);

    // The body applies it and posts the ack; the head's POST resolves.
    core.resolveAck(ackFrame("in-1", true, ""));
    const ack = await steerAck;
    expect(ack.ok).toBe(true);
  });

  it("maps a not-pending verdict ack back to the head", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_verdict" });
    const pending = core.enqueueInput(verdictFrame("in-2", "req-1", true, "lgtm"), "usr_bob");
    core.pollInputs(0);
    core.resolveAck(ackFrame("in-2", false, ATTACH_ACK_REASONS.notPending));
    const ack = await pending;
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe(ATTACH_ACK_REASONS.notPending);
  });

  it("refuses inputs after terminal with a terminal ack", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_term" });
    await core.close("terminal");
    const ack = await core.enqueueInput(steerFrame("in-3", "late"), "usr_x");
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe(ATTACH_ACK_REASONS.terminal);
  });
});

describe("RelayCore: durability and terminal", () => {
  it("rehydrates events and state from storage after eviction", async () => {
    const storage = memStorage();
    const core1 = new RelayCore(storage, { sessionId: "as_rehydrate", runKind: "interactive" });
    await core1.ingestEvents([
      eventFrame(0, "state_changed", "", { state: "running" }),
      eventFrame(1, "cost_sample", "", { tokens: 4812 }),
      eventFrame(2, "state_changed", "", { state: "completing" }),
    ]);

    // A fresh core over the same storage (DO cold start) replays identically.
    const core2 = new RelayCore(storage, { sessionId: "as_rehydrate" });
    await core2.load();
    const h = collectSink("h");
    core2.attach(h, -1);
    expect(h.frames[0]!.t).toBe("hello");
    expect(h.frames[0]!.state).toBe("completing"); // last state survived
    expect(h.frames[0]!.latestSeq).toBe(2);
    const events = h.frames.filter((f) => f.t === "event");
    expect(events.map((f) => f.seq)).toEqual([0, 1, 2]);
  });

  it("closes every head with a bye on a bye ingest", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_bye" });
    const h = collectSink("h");
    core.attach(h, -1);
    await core.ingestEvents([eventFrame(0, "state_changed", "", { state: "completed" }), byeFrame("terminal")]);
    expect(h.frames.at(-1)?.t).toBe("bye");
    expect(h.closed).toBe(true);
    expect(core.isClosed()).toBe(true);
    expect(core.headCount()).toBe(0);
  });

  it("a head attaching after terminal gets an immediate bye", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_late" });
    await core.close("terminal");
    const h = collectSink("h");
    core.attach(h, -1);
    expect(h.frames.some((f) => f.t === "bye")).toBe(true);
    expect(h.closed).toBe(true);
  });
});
