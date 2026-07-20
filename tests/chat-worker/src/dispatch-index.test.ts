// DispatchIndex core (saas-dispatch DX1). Invariants under test: the object
// holds NO authorized content (shell = cursor + counts only); a head's
// advancing report persists and fans out to every OTHER head; stale/equal
// reports are no-ops (idempotent convergence); the worker-side ring reaches
// every head; the shell survives a reload (hibernation); the router serves
// the WS attach + shell behind the chat grant and rings after a turn.

import { DispatchIndexCore, cursorAdvances, parseCursor } from "@chat-worker/dispatch-core";
import type { ChatStorage, ConnectionLike } from "@chat-worker/chat-thread";
import { route, type ChatDeps } from "@chat-worker/router";
import type { Env } from "@chat-worker/env";

// ── Fakes (the chat-thread test discipline) ────────────────────────────────

function memoryStorage(): ChatStorage {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
    },
    async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
      const out = new Map<string, T>();
      for (const [k, v] of map) if (k.startsWith(options.prefix)) out.set(k, v as T);
      return out;
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
  };
}

function fakeConn(id: string): ConnectionLike & { sent: string[] } {
  const sent: string[] = [];
  return {
    id,
    sent,
    send(msg: string) {
      sent.push(msg);
    },
    close() {},
    setState() {},
    state: null,
  };
}

function frames(conn: { sent: string[] }): Array<Record<string, unknown>> {
  return conn.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
}

const AT = "2026-07-20T12:00:00Z";

describe("cursor watermark", () => {
  it("parses w<coord>.<obs> and rejects junk", () => {
    expect(parseCursor("w42.17")).toEqual({ coord: 42, obs: 17 });
    expect(parseCursor("42.17")).toBeNull();
    expect(parseCursor("w42")).toBeNull();
  });
  it("advances in fold order", () => {
    expect(cursorAdvances("w0.0", "w1.0")).toBe(true);
    expect(cursorAdvances("w1.5", "w1.6")).toBe(true);
    expect(cursorAdvances("w1.5", "w2.0")).toBe(true);
    expect(cursorAdvances("w1.5", "w1.5")).toBe(false);
    expect(cursorAdvances("w2.0", "w1.9")).toBe(false);
    expect(cursorAdvances("w1.0", "garbage")).toBe(false);
  });
});

describe("DispatchIndexCore", () => {
  it("sends the snapshot-first shell then live on connect", async () => {
    const core = new DispatchIndexCore(memoryStorage());
    await core.load();
    const head = fakeConn("h1");
    core.connect(head);
    const [shell, live] = frames(head);
    expect(shell!.t).toBe("situation:shell");
    expect(shell!.cursor).toBe("w0.0");
    expect(live!.t).toBe("live");
  });

  it("an advancing report persists and invalidates every OTHER head", async () => {
    const storage = memoryStorage();
    const core = new DispatchIndexCore(storage);
    await core.load();
    const reporter = fakeConn("h1");
    const other = fakeConn("h2");
    core.connect(reporter);
    core.connect(other);
    reporter.sent.length = 0;
    other.sent.length = 0;

    const res = await core.report("h1", "w42.17", { ready: 3, running: 1 }, AT);
    expect(res.advanced).toBe(true);
    expect(reporter.sent).toHaveLength(0); // the reporter already has it
    const [inv] = frames(other);
    expect(inv!.t).toBe("situation:invalidate");
    expect(inv!.cursor).toBe("w42.17");
    expect(core.shellState()).toEqual({ cursor: "w42.17", counts: { ready: 3, running: 1 }, updatedAt: AT });
  });

  it("stale and equal reports are no-ops (idempotent convergence)", async () => {
    const core = new DispatchIndexCore(memoryStorage());
    await core.load();
    const a = fakeConn("h1");
    const b = fakeConn("h2");
    core.connect(a);
    core.connect(b);
    await core.report("h1", "w42.17", { ready: 3 }, AT);
    b.sent.length = 0;
    a.sent.length = 0;

    expect((await core.report("h2", "w42.17", { ready: 3 }, AT)).advanced).toBe(false);
    expect((await core.report("h2", "w41.99", { ready: 9 }, AT)).advanced).toBe(false);
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(0);
    expect(core.shellState().counts).toEqual({ ready: 3 });
  });

  it("ring reaches EVERY head, section-tagged, without advancing the cursor", async () => {
    const core = new DispatchIndexCore(memoryStorage());
    await core.load();
    const a = fakeConn("h1");
    const b = fakeConn("h2");
    core.connect(a);
    core.connect(b);
    a.sent.length = 0;
    b.sent.length = 0;

    core.ring("inFlight", AT);
    for (const head of [a, b]) {
      const [inv] = frames(head);
      expect(inv!.t).toBe("situation:invalidate");
      expect(inv!.section).toBe("inFlight");
      expect(inv!.cursor).toBeUndefined();
    }
    expect(core.shellState().cursor).toBe("w0.0");
  });

  it("the shell survives a reload (hibernation)", async () => {
    const storage = memoryStorage();
    const first = new DispatchIndexCore(storage);
    await first.load();
    await first.report(null, "w10.4", { ready: 2, verdict: 1 }, AT);

    const reborn = new DispatchIndexCore(storage);
    await reborn.load();
    expect(reborn.shellState()).toEqual({ cursor: "w10.4", counts: { ready: 2, verdict: 1 }, updatedAt: AT });
    const head = fakeConn("h9");
    reborn.connect(head);
    expect(frames(head)[0]!.cursor).toBe("w10.4");
  });

  it("handles head frames: report advances, ping pongs, junk is ignored", async () => {
    const core = new DispatchIndexCore(memoryStorage());
    await core.load();
    const head = fakeConn("h1");
    core.connect(head);
    head.sent.length = 0;

    await core.handleMessage(head, JSON.stringify({ v: 1, t: "ping" }), AT);
    expect(frames(head)[0]!.t).toBe("pong");

    await core.handleMessage(head, JSON.stringify({ v: 1, t: "situation:report", cursor: "w5.0" }), AT);
    expect(core.shellState().cursor).toBe("w5.0");

    await core.handleMessage(head, "not json", AT);
    await core.handleMessage(head, JSON.stringify({ t: "unknown-frame" }), AT);
    expect(core.shellState().cursor).toBe("w5.0");
  });

  it("holds no authorized content — the stored shell is cursor + counts only", async () => {
    const storage = memoryStorage();
    const core = new DispatchIndexCore(storage);
    await core.load();
    await core.report(null, "w1.0", { ready: 1 }, AT);
    const stored = (await storage.get("dx:shell")) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["counts", "cursor", "updatedAt"]);
  });
});

// ── Router integration (the chat-worker route) ─────────────────────────────

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const INDEX_PATH = `/v1/organizations/${ORG}/dispatch/index`;

function makeDeps(allowed = true): ChatDeps {
  return {
    async authorize() {
      return allowed;
    },
    now: () => new Date(AT),
    newChatId: () => "ch_x",
  };
}

function fakeDispatchNs(): {
  ns: NonNullable<Env["DISPATCH_INDEX"]>;
  rings: string[];
  attached: Request[];
} {
  const rings: string[] = [];
  const attached: Request[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: () =>
      ({
        async ring(section?: string) {
          rings.push(section ?? "*");
        },
        async shell() {
          return { cursor: "w7.7", counts: { ready: 2 }, updatedAt: AT };
        },
        fetch(req: Request) {
          attached.push(req);
          // A real DO answers 101 via partyserver; Node's Response cannot
          // carry 101, so the fake marks the pass-through instead.
          return Promise.resolve(new Response("upgraded", { status: 200, headers: { "x-fake-upgrade": "1" } }));
        },
      }) as never,
  } as unknown as NonNullable<Env["DISPATCH_INDEX"]>;
  return { ns, rings, attached };
}

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://chat-worker${path}`, {
    method: "GET",
    headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user", ...headers },
  });
}

describe("dispatch index route (DX1)", () => {
  it("serves the snapshot-first shell on a plain GET", async () => {
    const { ns } = fakeDispatchNs();
    const res = await route(req(INDEX_PATH), { ENVIRONMENT: "test", DISPATCH_INDEX: ns } as Env, makeDeps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cursor: string; counts: Record<string, number> } };
    expect(body.data.cursor).toBe("w7.7");
    expect(body.data.counts).toEqual({ ready: 2 });
  });

  it("forwards a WS upgrade to the DO", async () => {
    const { ns, attached } = fakeDispatchNs();
    const res = await route(
      req(INDEX_PATH, { upgrade: "websocket" }),
      { ENVIRONMENT: "test", DISPATCH_INDEX: ns } as Env,
      makeDeps(),
    );
    expect(res.headers.get("x-fake-upgrade")).toBe("1"); // returned untouched
    expect(attached).toHaveLength(1);
    expect(attached[0]!.headers.get("upgrade")).toBe("websocket");
  });

  it("denies without the chat grant and 503s when unbound", async () => {
    const { ns } = fakeDispatchNs();
    const denied = await route(req(INDEX_PATH), { ENVIRONMENT: "test", DISPATCH_INDEX: ns } as Env, makeDeps(false));
    expect(denied.status).toBe(403);
    const unbound = await route(req(INDEX_PATH), { ENVIRONMENT: "test" } as Env, makeDeps());
    expect(unbound.status).toBe(503);
  });

  it("401s without an actor", async () => {
    const { ns } = fakeDispatchNs();
    const res = await route(
      new Request(`https://chat-worker${INDEX_PATH}`),
      { ENVIRONMENT: "test", DISPATCH_INDEX: ns } as Env,
      makeDeps(),
    );
    expect(res.status).toBe(401);
  });
});
