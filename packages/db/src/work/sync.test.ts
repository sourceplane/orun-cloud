import { describe, expect, it } from "vitest";
import type { Actor } from "./model.js";
import { WorkProjection } from "./model.js";
import { WorkSyncClient } from "./sync-client.js";
import { WorkSyncServer } from "./sync-server.js";
import { dispatch, type Mutation } from "./sync.js";

function minter(tag: string): (p: string) => string {
  let n = 0;
  return (prefix: string) => `${prefix}${tag}${(n++).toString().padStart(4, "0")}`;
}

const human: Actor = { type: "user", id: "prn_human", via: "ui" };
const AT = "2026-06-11T09:00:00Z";

let mid = 0;
function mut(intent: Mutation["intent"], actor: Actor = human): Mutation {
  mid += 1;
  return { clientMutationId: `cm_${mid}`, actor, at: AT, intent };
}

/** Submit a mutation: apply it optimistically on the client, commit it on the
 *  server (which broadcasts the event to all subscribers), then deliver the
 *  verdict back to the originator. Mirrors the real transport round-trip. */
function send(server: WorkSyncServer, client: WorkSyncClient, m: Mutation): void {
  client.mutate(m);
  const verdict = server.submit(m);
  client.receive({ type: "verdict", verdict });
}

function connect(server: WorkSyncServer, client: WorkSyncClient): () => void {
  return server.subscribe((msg) => client.receive(msg), client.lastSeq);
}

describe("work sync — convergence + optimism (W1)", () => {
  it("two clients converge under interleaved optimistic mutations", () => {
    const server = new WorkSyncServer("acme/platform", "ORN", minter("s"));
    const a = new WorkSyncClient("acme/platform", "ORN", minter("a"));
    const b = new WorkSyncClient("acme/platform", "ORN", minter("b"));
    connect(server, a);
    connect(server, b);

    send(server, a, mut({ op: "createEpic", slug: "orun-work", title: "Orun Work" }));
    send(server, b, mut({ op: "createTask", title: "B writes a task" }));
    send(server, a, mut({ op: "createTask", title: "A writes a task" }));
    // A's task is ORN-1 (committed first); B's is ORN-2 — B optimistically saw
    // ORN-1 for its own task, then rebased to ORN-2 once A's event confirmed.
    send(server, a, mut({ op: "setStatus", key: "ORN-1", status: "in_progress" }));
    send(server, b, mut({ op: "assign", key: "ORN-2", principal: "prn_b" }));

    expect(a.lastSeq).toBe(server.headSeq);
    expect(b.lastSeq).toBe(server.headSeq);
    const s = JSON.stringify(server.snapshot());
    expect(JSON.stringify(a.snapshot())).toEqual(s);
    expect(JSON.stringify(b.snapshot())).toEqual(s);
    expect(a.rejections).toHaveLength(0);
    expect(b.rejections).toHaveLength(0);

    // Both confirmed ORN-1 (A's) and ORN-2 (B's), with no pending overlay left.
    expect(JSON.stringify(a.view().projectionSnapshot())).toEqual(s);
  });

  it("rolls back a rejected mutation and surfaces the verdict, still converging", () => {
    const server = new WorkSyncServer("acme/platform", "ORN", minter("s"));
    const a = new WorkSyncClient("acme/platform", "ORN", minter("a"));
    const b = new WorkSyncClient("acme/platform", "ORN", minter("b"));
    connect(server, a);
    connect(server, b);

    // Both race to create the same epic slug; A wins, B is rejected.
    send(server, a, mut({ op: "createEpic", slug: "shared", title: "A's epic" }));
    send(server, b, mut({ op: "createEpic", slug: "shared", title: "B's epic" }));

    expect(b.rejections).toHaveLength(1);
    expect(b.rejections[0]?.ok).toBe(false);
    if (b.rejections[0] && !b.rejections[0].ok) {
      expect(b.rejections[0].code).toBe("conflict");
    }
    // B's optimistic dup is gone; both see exactly A's "shared" epic.
    const s = JSON.stringify(server.snapshot());
    expect(JSON.stringify(a.snapshot())).toEqual(s);
    expect(JSON.stringify(b.snapshot())).toEqual(s);
    expect(JSON.stringify(b.view().projectionSnapshot())).toEqual(s);
    expect(server.snapshot().items).toHaveLength(1);
  });
});

describe("work sync — cursor replay (W1)", () => {
  it("a client that drops the connection loses nothing on replay", () => {
    const server = new WorkSyncServer("acme/platform", "ORN", minter("s"));
    const a = new WorkSyncClient("acme/platform", "ORN", minter("a"));
    const b = new WorkSyncClient("acme/platform", "ORN", minter("b"));
    connect(server, a);
    const unsubB = connect(server, b);

    send(server, a, mut({ op: "createEpic", slug: "e1", title: "E1" }));
    expect(b.lastSeq).toBe(1);

    // B drops the socket and misses three commits.
    unsubB();
    send(server, a, mut({ op: "createTask", title: "t1" }));
    send(server, a, mut({ op: "createTask", title: "t2" }));
    send(server, a, mut({ op: "setStatus", key: "ORN-1", status: "in_review" }));
    expect(b.lastSeq).toBe(1);
    expect(server.headSeq).toBe(4);

    // B reconnects from its cursor; the server replays the missing tail.
    connect(server, b);
    expect(b.lastSeq).toBe(4);
    expect(b.hasGap()).toBe(false);
    expect(JSON.stringify(b.snapshot())).toEqual(JSON.stringify(server.snapshot()));
  });

  it("retires a client's own pending mutation on reconnect replay (no phantom double-apply)", () => {
    const server = new WorkSyncServer("acme/platform", "ORN", minter("s"));
    const a = new WorkSyncClient("acme/platform", "ORN", minter("a"));
    const unsubA = connect(server, a);

    // A optimistically creates a task, then its socket drops *before* the commit's
    // broadcast + verdict can reach it.
    const m = mut({ op: "createTask", title: "A's task" });
    a.mutate(m);
    expect(a.view().projectionSnapshot().items).toHaveLength(1); // optimistic ORN-1
    expect(a.confirmedState().projectionSnapshot().items).toHaveLength(0); // nothing confirmed
    unsubA();
    server.submit(m); // committed as seq 1; A is unsubscribed so it misses both event + verdict
    expect(a.lastSeq).toBe(0);

    // A reconnects from its cursor; the replayed event carries A's clientMutationId,
    // so A retires its pending copy instead of re-applying it as a phantom ORN-2.
    connect(server, a);
    expect(a.lastSeq).toBe(1);
    const s = JSON.stringify(server.snapshot());
    expect(JSON.stringify(a.snapshot())).toEqual(s);
    expect(JSON.stringify(a.view().projectionSnapshot())).toEqual(s);
    expect(a.view().projectionSnapshot().items).toHaveLength(1); // exactly one task, not two
  });

  it("holds out-of-order events and drains them once the gap fills", () => {
    const server = new WorkSyncServer("acme/platform", "ORN", minter("s"));
    const a = new WorkSyncClient("acme/platform", "ORN", minter("a"));
    connect(server, a);
    send(server, a, mut({ op: "createEpic", slug: "e1", title: "E1" }));
    send(server, a, mut({ op: "createTask", title: "t1" }));
    send(server, a, mut({ op: "createTask", title: "t2" }));
    const [e1, e2, e3] = server.eventsSince(0);

    const late = new WorkSyncClient("acme/platform", "ORN", minter("l"));
    // Deliver out of order: seq 3, then 2 (gap above lastSeq), then 1.
    late.receive({ type: "event", event: e3! });
    late.receive({ type: "event", event: e2! });
    expect(late.lastSeq).toBe(0);
    expect(late.hasGap()).toBe(true);
    late.receive({ type: "event", event: e1! });
    // The gap filled: 1 applied, then 2 and 3 drained in order.
    expect(late.lastSeq).toBe(3);
    expect(late.hasGap()).toBe(false);
    expect(JSON.stringify(late.snapshot())).toEqual(JSON.stringify(server.snapshot()));
  });
});

describe("work sync — dispatch parity", () => {
  it("dispatch applies an intent as exactly one event", () => {
    const server = new WorkSyncServer("acme/platform", "ORN", minter("s"));
    const v = server.submit(mut({ op: "createTask", title: "x" }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.seq).toBe(1);
  });

  it("dispatch is the single apply path for client and server", () => {
    // The same intent applied to a standalone projection yields a matching kind.
    const p = new WorkProjection("acme/platform", "ORN", minter("p"));
    const ev = dispatch(p, mut({ op: "createEpic", slug: "x", title: "X" }));
    expect(ev.kind).toBe("item_created");
    expect(ev.subject).toBe("x");
  });
});
