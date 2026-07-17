// AN1 conformance (saas-agents-native): the WS binding and the SSE binding
// are the SAME relay — the golden fixtures driven through relay-shell over a
// fake WS connection and over the SSE sink must produce byte-identical frame
// logs (the AL6 discipline, now with two carriages). Plus the hibernation
// seam: a head whose socket survives a DO eviction rejoins the fan-out set
// with no frame loss and no duplication.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayCore, type RelayStorage, type HeadSink } from "../../../apps/agents-worker/src/relay-core.js";
import {
  connectHead,
  handleBodyRequest,
  handleHeadMessage,
  rejoinHead,
  type ConnectionLike,
} from "../../../apps/agents-worker/src/relay-shell.js";
import {
  type AttachFrame,
  decodeFrames,
  encodeFrame,
  eventFrame,
  steerFrame,
  verdictFrame,
  ackFrame,
} from "@saas/contracts/agents-attach";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "../../../packages/contracts/src/agents-attach-fixtures");

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

/** A fake `agents` Connection: collects sent messages, persists state like
 * serializeAttachment would (surviving "eviction" because the test holds it). */
function fakeConn(id: string): ConnectionLike & { sent: string[]; closed: boolean; connState: unknown } {
  const conn = {
    id,
    sent: [] as string[],
    closed: false,
    connState: null as unknown,
    send(msg: string) {
      conn.sent.push(msg);
    },
    close() {
      conn.closed = true;
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

function collectSink(id: string, principal = "usr_x", surface = "console"): HeadSink & { frames: AttachFrame[] } {
  const frames: AttachFrame[] = [];
  return {
    id,
    principal,
    surface,
    frames,
    send(f: AttachFrame) {
      frames.push(f);
    },
    close() {
      /* no-op */
    },
  };
}

function attachURL(from: number, surface: string, principal: string): URL {
  return new URL(
    `https://relay/attach?from=${from}&surface=${encodeURIComponent(surface)}&principal=${encodeURIComponent(principal)}`,
  );
}

/** The body-event frames of a fixture (what `orun agent serve` would POST). */
function fixtureEvents(file: string): AttachFrame[] {
  const raw = readFileSync(join(FIXTURE_DIR, file), "utf8");
  return decodeFrames(raw).filter((f) => f.t === "event");
}

const FIXTURES = [
  "attach-replay-live.ndjson",
  "steer-and-verdict.ndjson",
  "interrupt-and-end.ndjson",
  "resume-from-cursor.ndjson",
  "verdict-race.ndjson",
  "errors.ndjson",
];

describe("AN1: WS and SSE bindings are frame-log identical", () => {
  it.each(FIXTURES)("%s: replay + live fan-out matches byte-for-byte", async (file) => {
    const events = fixtureEvents(file);
    const mid = Math.floor(events.length / 2);
    const info = { sessionId: "as_conform", runKind: "implementation" };

    // One core, both heads attached before the live half — every fan-out
    // reaches both carriages.
    const core = new RelayCore(memStorage(), info);
    await core.ingestEvents(events.slice(0, mid));

    const ws = fakeConn("ws-head");
    connectHead(core, ws, attachURL(-1, "tui", "usr_alice"));
    const sse = collectSink("sse-head", "usr_alice", "tui");
    core.attach(sse, -1);

    await core.ingestEvents(events.slice(mid));

    // The WS log is one encoded frame per message; the SSE log is the same
    // frames through encodeFrame. The WS head attached first so it also saw
    // the second head's presence announce; the SSE head saw its own. Compare
    // the non-presence spine byte-for-byte (presence is advisory chatter, and
    // arrival-order relative to attach differs by definition between two
    // sequential attaches).
    const wsLog = ws.sent.map((m) => encodeFrame(JSON.parse(m) as AttachFrame)).filter((l) => !l.includes('"t":"presence"'));
    const sseLog = sse.frames.map((f) => encodeFrame(f)).filter((l) => !l.includes('"t":"presence"'));
    expect(wsLog).toEqual(sseLog);
    expect(wsLog.length).toBeGreaterThan(0);
  });

  it("a WS head input round-trips with the same ack bytes the HTTP POST path returns", async () => {
    const info = { sessionId: "as_input_conform" };

    // WS path: steer over the socket, body drains + acks via the HTTP wire.
    const wsCore = new RelayCore(memStorage(), info);
    const ws = fakeConn("h1");
    connectHead(wsCore, ws, attachURL(-1, "console", "usr_alice"));
    const wsDone = handleHeadMessage(wsCore, ws, encodeFrame(steerFrame("in-1", "also update the changelog")));
    const poll = await handleBodyRequest(wsCore, new Request("https://relay/inputs?cursor=0"), async () => wsCore);
    const { items } = (await poll.json()) as { items: AttachFrame[] };
    expect(items).toHaveLength(1);
    expect(items[0]!.payload?.principal).toBe("usr_alice"); // edge-stamped
    await handleBodyRequest(
      wsCore,
      new Request("https://relay/inputs/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeFrame(ackFrame("in-1", true, "")),
      }),
      async () => wsCore,
    );
    await wsDone;
    const wsAck = ws.sent[ws.sent.length - 1]!;

    // HTTP path: the same steer through POST /input on a fresh core.
    const httpCore = new RelayCore(memStorage(), info);
    const ackP = handleBodyRequest(
      httpCore,
      new Request("https://relay/input", {
        method: "POST",
        headers: { "content-type": "application/json", "x-actor-principal": "usr_alice" },
        body: encodeFrame(steerFrame("in-1", "also update the changelog")),
      }),
      async () => httpCore,
    );
    // Let the POST's body parse + enqueue land before the body polls.
    await new Promise((r) => setTimeout(r, 0));
    const poll2 = await handleBodyRequest(httpCore, new Request("https://relay/inputs?cursor=0"), async () => httpCore);
    expect(((await poll2.json()) as { items: AttachFrame[] }).items).toHaveLength(1);
    await handleBodyRequest(
      httpCore,
      new Request("https://relay/inputs/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeFrame(ackFrame("in-1", true, "")),
      }),
      async () => httpCore,
    );
    const httpAck = encodeFrame((await (await ackP).json()) as AttachFrame);

    expect(wsAck).toBe(httpAck);
  });

  it("a verdict over WS reaches the body poll exactly once", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_verdict" });
    const ws = fakeConn("h1");
    connectHead(core, ws, attachURL(-1, "console", "usr_bob"));
    const done = handleHeadMessage(core, ws, encodeFrame(verdictFrame("in-2", "req-1", true, "lgtm")));

    const poll1 = await handleBodyRequest(core, new Request("https://relay/inputs?cursor=0"), async () => core);
    const r1 = (await poll1.json()) as { items: AttachFrame[]; cursor: number };
    expect(r1.items).toHaveLength(1);
    expect(r1.items[0]!.t).toBe("verdict");
    expect(r1.items[0]!.approved).toBe(true);

    // The body advances its cursor: the verdict is delivered exactly once.
    const poll2 = await handleBodyRequest(core, new Request(`https://relay/inputs?cursor=${r1.cursor}`), async () => core);
    expect(((await poll2.json()) as { items: AttachFrame[] }).items).toHaveLength(0);

    await handleBodyRequest(
      core,
      new Request("https://relay/inputs/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeFrame(ackFrame("in-2", true, "")),
      }),
      async () => core,
    );
    await done;
    const ack = JSON.parse(ws.sent[ws.sent.length - 1]!) as AttachFrame;
    expect(ack.t).toBe("ack");
    expect(ack.ok).toBe(true);
  });
});

describe("AN1: the hibernation seam", () => {
  it("a rejoined head resumes fan-out with no loss and no duplication", async () => {
    const storage = memStorage();
    const core1 = new RelayCore(storage, { sessionId: "as_hib" });
    await core1.load();

    const ws = fakeConn("h1");
    connectHead(core1, ws, attachURL(-1, "tui", "usr_alice"));
    await core1.ingestEvents([
      eventFrame(0, "state_changed", "", { state: "running" }),
      eventFrame(1, "message_agent", "", { text: "before eviction" }),
    ]);

    // Eviction: in-memory core is gone; the socket (and its state) survives.
    const core2 = new RelayCore(storage, { sessionId: "as_hib" });
    await core2.load();
    rejoinHead(core2, ws); // ensureLoaded's wake choreography
    await core2.ingestEvents([eventFrame(2, "message_agent", "", { text: "after wake" })]);

    const frames = ws.sent.map((m) => JSON.parse(m) as AttachFrame);
    const seqs = frames.filter((f) => f.t === "event").map((f) => f.seq);
    expect(seqs).toEqual([0, 1, 2]); // no gap, no duplicate
    // No second hello: the socket never dropped, so no re-attach choreography.
    expect(frames.filter((f) => f.t === "hello")).toHaveLength(1);
  });

  it("rejoin skips a connection that never completed connectHead", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_mid" });
    const ws = fakeConn("h1"); // state never set: mid-onConnect
    rejoinHead(core, ws);
    expect(core.headCount()).toBe(0);
  });

  it("rejoining a closed relay answers bye and closes, never silently joins", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_sealed" });
    const ws = fakeConn("h1");
    connectHead(core, ws, attachURL(-1, "tui", "usr_alice"));
    await core.close("terminal");
    ws.closed = false; // the transport survived; the relay must re-answer

    rejoinHead(core, ws);
    const last = JSON.parse(ws.sent[ws.sent.length - 1]!) as AttachFrame;
    expect(last.t).toBe("bye");
    expect(last.reason).toBe("terminal");
    expect(ws.closed).toBe(true);
    expect(core.headCount()).toBe(0);
  });
});

describe("AN1: the body HTTP surface through the shell", () => {
  it("serves the AL6 routes byte-identically (events → accepted, SSE fallback intact)", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_body" });
    const events = fixtureEvents("attach-replay-live.ndjson");

    const res = await handleBodyRequest(
      core,
      new Request("https://relay/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(events),
      }),
      async () => core,
    );
    expect(((await res.json()) as { accepted: number }).accepted).toBe(events.length);

    // Duplicate batch: dedupe by seq, zero accepted.
    const dup = await handleBodyRequest(
      core,
      new Request("https://relay/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(events),
      }),
      async () => core,
    );
    expect(((await dup.json()) as { accepted: number }).accepted).toBe(0);

    // SSE fallback stays a first-class binding on the same class.
    const sse = await handleBodyRequest(core, new Request("https://relay/attach?from=-1&surface=console&principal=usr_x"), async () => core);
    expect(sse.headers.get("content-type")).toBe("text/event-stream");

    // Unknown path: 404, exactly as the old shell answered.
    const missing = await handleBodyRequest(core, new Request("https://relay/nope"), async () => core);
    expect(missing.status).toBe(404);
  });

  it("POST /init rebuilds the core around fresh session info", async () => {
    let core = new RelayCore(memStorage(), { sessionId: "" });
    const res = await handleBodyRequest(
      core,
      new Request("https://relay/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "as_new", runKind: "interactive" }),
      }),
      async (info) => {
        core = new RelayCore(memStorage(), info);
        await core.load();
        return core;
      },
    );
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const ws = fakeConn("h1");
    connectHead(core, ws, attachURL(-1, "console", "usr_x"));
    expect((JSON.parse(ws.sent[0]!) as AttachFrame).sessionId).toBe("as_new");
  });
});

describe("AN1: WS protocol edges", () => {
  it("a malformed WS message answers an error frame, never a dropped socket", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_bad" });
    const ws = fakeConn("h1");
    connectHead(core, ws, attachURL(-1, "console", "usr_x"));
    await handleHeadMessage(core, ws, "not json{");
    const last = JSON.parse(ws.sent[ws.sent.length - 1]!) as AttachFrame;
    expect(last.t).toBe("error");
    expect(last.code).toBe("bad_frame");
    expect(ws.closed).toBe(false);
  });

  it("a detach frame leaves presence and closes cleanly", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_detach" });
    const ws = fakeConn("h1");
    connectHead(core, ws, attachURL(-1, "console", "usr_x"));
    expect(core.headCount()).toBe(1);
    await handleHeadMessage(core, ws, encodeFrame({ v: 1, t: "detach" }));
    expect(core.headCount()).toBe(0);
    expect(ws.closed).toBe(true);
  });

  it("non-input body frames from a head are ignored (forward compatibility)", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_fwd" });
    const ws = fakeConn("h1");
    connectHead(core, ws, attachURL(-1, "console", "usr_x"));
    const before = ws.sent.length;
    await handleHeadMessage(core, ws, encodeFrame({ v: 1, t: "pong", at: "2026-07-17T00:00:00Z" }));
    await handleHeadMessage(core, ws, JSON.stringify({ v: 1, t: "future_frame_kind" }));
    expect(ws.sent.length).toBe(before); // nothing answered, nothing broken
  });

  it("the attach cursor resumes without duplicates (fixture: resume-from-cursor)", async () => {
    const events = fixtureEvents("resume-from-cursor.ndjson");
    const core = new RelayCore(memStorage(), { sessionId: "as_resume" });
    await core.ingestEvents(events);
    const latest = events[events.length - 1]!.seq!;

    // First attach from -1 sees everything; a reconnect from the highest
    // folded seq replays nothing and goes straight live.
    const ws = fakeConn("h2");
    connectHead(core, ws, attachURL(latest, "tui", "usr_alice"));
    const frames = ws.sent.map((m) => JSON.parse(m) as AttachFrame);
    expect(frames.filter((f) => f.t === "event")).toHaveLength(0);
    expect(frames.map((f) => f.t)).toContain("live");
  });
});

// ── AN2: the body wire (AN0's cloud door) ──────────────────────────────────

import { RelayShell } from "../../../apps/agents-worker/src/relay-shell.js";

function wireURL(): URL {
  return new URL("https://relay/wire");
}

describe("AN2: the body wire on the shell", () => {
  it("pushes a head input to the connected wire at enqueue time, principal-stamped", async () => {
    const shell = new RelayShell(memStorage(), { sessionId: "as_w1" });
    await shell.load();
    const body = fakeConn("wire-1");
    shell.connect(body, wireURL());

    const head = fakeConn("head-1");
    shell.connect(head, attachURL(-1, "console", "usr_alice"));
    const done = shell.message(head, encodeFrame(steerFrame("in-1", "ship it")));

    // The wire got the push immediately — before any ack, before any poll.
    const pushed = body.sent.map((m) => JSON.parse(m) as AttachFrame).find((f) => f.t === "steer");
    expect(pushed).toBeDefined();
    expect(pushed!.payload?.principal).toBe("usr_alice");

    // The body acks over the wire; the head's blocking send resolves.
    await shell.message(body, encodeFrame(ackFrame("in-1", true, "")));
    await done;
    const headAck = JSON.parse(head.sent[head.sent.length - 1]!) as AttachFrame;
    expect(headAck.t).toBe("ack");
    expect(headAck.ok).toBe(true);
  });

  it("re-pushes only the UNACKED backlog on a fresh wire connect", async () => {
    const storage = memStorage();
    const shell = new RelayShell(storage, { sessionId: "as_w2" });
    await shell.load();
    const head = fakeConn("head-1");
    shell.connect(head, attachURL(-1, "console", "usr_alice"));

    // Two inputs while NO wire is connected; the first gets acked over HTTP
    // (the long-poll world), the second stays pending.
    void shell.message(head, encodeFrame(steerFrame("in-1", "first")));
    void shell.message(head, encodeFrame(steerFrame("in-2", "second")));
    await shell.bodyRequest(
      new Request("https://relay/inputs/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodeFrame(ackFrame("in-1", true, "")),
      }),
    );

    const body = fakeConn("wire-1");
    shell.connect(body, wireURL());
    const pushed = body.sent.map((m) => JSON.parse(m) as AttachFrame).filter((f) => f.t === "steer");
    expect(pushed.map((f) => f.ref)).toEqual(["in-2"]); // in-1 acked, not re-pushed
  });

  it("persists the acked set across hibernation (no duplicate re-push after eviction)", async () => {
    const storage = memStorage();
    const shell1 = new RelayShell(storage, { sessionId: "as_w3" });
    await shell1.load();
    const head = fakeConn("head-1");
    shell1.connect(head, attachURL(-1, "console", "usr_a"));
    void shell1.message(head, encodeFrame(steerFrame("in-1", "x")));
    const wire1 = fakeConn("wire-1");
    shell1.connect(wire1, wireURL());
    await shell1.message(wire1, encodeFrame(ackFrame("in-1", true, "")));

    // Eviction: a new shell over the same storage; a fresh wire connects.
    const shell2 = new RelayShell(storage, { sessionId: "as_w3" });
    await shell2.load();
    const wire2 = fakeConn("wire-2");
    shell2.connect(wire2, wireURL());
    expect(wire2.sent.filter((m) => m.includes('"steer"'))).toHaveLength(0);
  });

  it("a wire delta fans out to heads; a wire bye closes the relay", async () => {
    const shell = new RelayShell(memStorage(), { sessionId: "as_w4" });
    await shell.load();
    const head = fakeConn("head-1");
    shell.connect(head, attachURL(-1, "console", "usr_a"));
    const body = fakeConn("wire-1");
    shell.connect(body, wireURL());

    await shell.message(body, encodeFrame({ v: 1, t: "delta", turn: 1, text: "strea" }));
    expect(head.sent.some((m) => m.includes('"delta"'))).toBe(true);

    await shell.message(body, encodeFrame({ v: 1, t: "bye", reason: "terminal" }));
    const last = JSON.parse(head.sent[head.sent.length - 1]!) as AttachFrame;
    expect(last.t).toBe("bye");
  });

  it("rejoins a hibernated wire without re-push, and inputs enqueued after the wake reach it", async () => {
    const storage = memStorage();
    const shell1 = new RelayShell(storage, { sessionId: "as_w5" });
    await shell1.load();
    const body = fakeConn("wire-1");
    shell1.connect(body, wireURL());
    const sentBefore = body.sent.length;

    // Eviction; the socket survives; the wake rejoins it silently.
    const shell2 = new RelayShell(storage, { sessionId: "as_w5" });
    await shell2.load();
    shell2.rejoin(body);
    expect(body.sent.length).toBe(sentBefore); // no re-push, no chatter

    const head = fakeConn("head-1");
    shell2.connect(head, attachURL(-1, "console", "usr_a"));
    void shell2.message(head, encodeFrame(steerFrame("in-9", "post-wake")));
    expect(body.sent.some((m) => m.includes('"in-9"'))).toBe(true);
  });

  it("the long-poll still serves everything (the wire is an accelerant, not the record)", async () => {
    const shell = new RelayShell(memStorage(), { sessionId: "as_w6" });
    await shell.load();
    const body = fakeConn("wire-1");
    shell.connect(body, wireURL());
    const head = fakeConn("head-1");
    shell.connect(head, attachURL(-1, "console", "usr_a"));
    void shell.message(head, encodeFrame(steerFrame("in-1", "x")));

    const poll = await shell.bodyRequest(new Request("https://relay/inputs?cursor=0"));
    const { items } = (await poll.json()) as { items: AttachFrame[] };
    expect(items.map((f) => f.ref)).toEqual(["in-1"]);
  });
});
