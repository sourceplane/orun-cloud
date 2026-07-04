import { describe, expect, it } from "vitest";
import { buildEnvelopes } from "./envelopes.js";
import { MemoryWorkRepository } from "./memory.js";
import { WorkError, fold } from "./model.js";
import type { WorkspaceScope } from "./types.js";

const SCOPE: WorkspaceScope = { orgId: "11111111-1111-1111-1111-111111111111" };
const USER = { type: "user" as const, id: "usr_1" };
const AGENT = { type: "agent" as const, id: "sp_1" };
const fixedClock = () => "2026-07-02T12:00:00Z";

function repo() {
  return new MemoryWorkRepository(fixedClock);
}

describe("mutators: one event each, mandatory actor", () => {
  it("every mutator appends exactly one event", async () => {
    const r = repo();
    await r.createSpec(SCOPE, { slug: "demo", title: "Demo", actor: USER });
    const { key } = await r.createTask(SCOPE, { prefix: "ORN", title: "t", specKey: "demo", actor: USER });
    await r.editItem(SCOPE, { key, title: "t2", actor: USER });
    await r.editContract(SCOPE, { key, contract: { goal: "g" }, actor: USER });
    await r.assign(SCOPE, { key, subject: "usr_2", actor: USER });
    await r.unassign(SCOPE, { key, subject: "usr_2", actor: USER });
    await r.comment(SCOPE, { key, body: "hi", actor: USER });
    await r.order(SCOPE, { key, view: "board", order: 1.5, actor: USER });
    await r.pin(SCOPE, { key, rung: "done", note: "override", actor: USER });
    await r.pin(SCOPE, { key, rung: null, actor: USER });
    await r.cancel(SCOPE, { key, actor: USER });

    const events = await r.listEvents(SCOPE);
    expect(events.length).toBe(11); // one event per mutation, nothing else
    // one event per mutation, contiguous seq
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    for (const e of events) {
      expect(e.actor?.id).toBeTruthy();
    }
  });

  it("rejects an actor-less mutation (invariant 3)", async () => {
    const r = repo();
    await expect(
      r.createSpec(SCOPE, { slug: "x", title: "X", actor: undefined as never }),
    ).rejects.toThrow(WorkError);
  });

  it("rejects agent pins in the mutator, not the client (WP-10)", async () => {
    const r = repo();
    await r.createSpec(SCOPE, { slug: "demo", title: "Demo", actor: USER });
    const { key } = await r.createTask(SCOPE, { prefix: "ORN", title: "t", actor: USER });
    await expect(r.pin(SCOPE, { key, rung: "done", actor: AGENT })).rejects.toThrow(/agents may not pin/);
    // agents can do the four allowed writes
    await expect(r.comment(SCOPE, { key, body: "on it", actor: AGENT })).resolves.toBeDefined();
    await expect(r.assign(SCOPE, { key, subject: "sp_1", actor: AGENT })).resolves.toBeDefined();
  });

  it("has no lifecycle mutator at all (WP-3)", () => {
    const r = repo() as unknown as Record<string, unknown>;
    expect(r.setStatus).toBeUndefined();
    expect(r.setLifecycle).toBeUndefined();
    expect(r.setRung).toBeUndefined();
  });

  it("allocates workspace-scoped PREFIX-n keys (WP-7)", async () => {
    const r = repo();
    const a = await r.createTask(SCOPE, { prefix: "ORN", title: "a", actor: USER });
    const b = await r.createTask(SCOPE, { prefix: "ORN", title: "b", actor: USER });
    const c = await r.createTask(SCOPE, { prefix: "OPS", title: "c", actor: USER });
    expect([a.key, b.key, c.key]).toEqual(["ORN-1", "ORN-2", "OPS-1"]);
    // second workspace starts fresh
    const other: WorkspaceScope = { orgId: "22222222-2222-2222-2222-222222222222" };
    const d = await r.createTask(other, { prefix: "ORN", title: "d", actor: USER });
    expect(d.key).toBe("ORN-1");
  });

  it("rejects duplicate spec slugs and unknown parents", async () => {
    const r = repo();
    await r.createSpec(SCOPE, { slug: "demo", title: "Demo", actor: USER });
    await expect(r.createSpec(SCOPE, { slug: "demo", title: "Again", actor: USER })).rejects.toThrow(/exists/);
    await expect(
      r.createTask(SCOPE, { prefix: "ORN", title: "t", specKey: "missing", actor: USER }),
    ).rejects.toThrow(/does not exist/);
    await expect(r.comment(SCOPE, { key: "ORN-999", body: "x", actor: USER })).rejects.toThrow(/unknown item/);
  });
});

describe("observations: world-authored, idempotent", () => {
  it("dedupes by dedupeKey — same fact twice folds identically (invariant 4)", async () => {
    const r = repo();
    const input = {
      workspace: SCOPE.orgId,
      source: "github-webhook",
      sourceVersion: 1,
      kind: "pr_opened" as const,
      at: fixedClock(),
      dedupeKey: "gh:pr:o/r#1:opened",
      payload: { pr: "o/r#1", taskKeys: ["ORN-1"] },
    };
    const first = await r.ingestObservation(SCOPE, input);
    expect(first.deduped).toBe(false);
    const second = await r.ingestObservation(SCOPE, input);
    expect(second.deduped).toBe(true);
    expect((await r.listObservations(SCOPE)).length).toBe(1);
  });

  it("rejects unsourced or undeduped facts loudly (P-2)", async () => {
    const r = repo();
    await expect(
      r.ingestObservation(SCOPE, {
        workspace: SCOPE.orgId,
        source: "",
        sourceVersion: 1,
        kind: "pr_opened",
        at: fixedClock(),
        dedupeKey: "k",
      }),
    ).rejects.toThrow(WorkError);
  });
});

describe("the droppable-cache guarantee (invariant 1)", () => {
  it("envelopes rebuild from the coordination log alone, byte-identical", async () => {
    const r = repo();
    await r.createSpec(SCOPE, { slug: "demo", title: "Demo", docRef: "sha256:aa", actor: USER });
    const { key } = await r.createTask(SCOPE, {
      prefix: "ORN",
      title: "original",
      specKey: "demo",
      contract: { goal: "g" },
      actor: USER,
    });
    await r.editItem(SCOPE, { key, title: "edited", actor: USER });
    await r.editContract(SCOPE, {
      key,
      contract: { goal: "g2", affects: ["a/b/c"], doneWhen: ["d"], gates: ["tests"] },
      actor: USER,
    });

    const events = await r.listEvents(SCOPE);
    const replayA = buildEnvelopes(SCOPE.orgId, events);
    const replayB = buildEnvelopes(SCOPE.orgId, events);
    expect(JSON.stringify(replayA)).toBe(JSON.stringify(replayB));

    const { tasks } = await r.getWorkSet(SCOPE);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.title).toBe("edited");
    expect(tasks[0]!.contract?.goal).toBe("g2");
    expect(JSON.stringify(tasks)).toBe(JSON.stringify(replayA.tasks));
  });
});

describe("end to end: mutate + observe + fold", () => {
  it("walks ready → in_review → done from the logs, with a pin beside truth", async () => {
    const r = repo();
    await r.createSpec(SCOPE, { slug: "demo", title: "Demo", actor: USER });
    const { key } = await r.createTask(SCOPE, {
      prefix: "ORN",
      title: "route reads",
      specKey: "demo",
      contract: { goal: "g", affects: ["ns/repo/api"], doneWhen: ["d"], gates: ["tests"] },
      actor: USER,
    });

    let ws = await r.getWorkSet(SCOPE);
    expect(fold(ws).lifecycles[key]!.rung).toBe("ready");

    await r.ingestObservation(SCOPE, {
      workspace: SCOPE.orgId,
      source: "github-webhook",
      sourceVersion: 1,
      kind: "pr_opened",
      at: fixedClock(),
      dedupeKey: "gh:pr:o/r#7:opened",
      payload: { pr: "o/r#7", taskKeys: [key] },
    });
    ws = await r.getWorkSet(SCOPE);
    expect(fold(ws).lifecycles[key]!.rung).toBe("in_review");
    expect(fold(ws).lifecycles[key]!.evidence).toEqual(["PR o/r#7 open"]);

    // human pins Released while truth says in_review — pin renders beside
    await r.pin(SCOPE, { key, rung: "released", note: "demo optimism", actor: USER });
    ws = await r.getWorkSet(SCOPE);
    let lc = fold(ws).lifecycles[key]!;
    expect(lc.rung).toBe("in_review");
    expect(lc.pinned?.rung).toBe("released");
    expect(lc.pinned?.by.id).toBe("usr_1");

    await r.ingestObservation(SCOPE, {
      workspace: SCOPE.orgId,
      source: "github-webhook",
      sourceVersion: 1,
      kind: "pr_merged",
      at: fixedClock(),
      dedupeKey: "gh:pr:o/r#7:merged",
      payload: { pr: "o/r#7", revision: "sha256:zz", taskKeys: [key] },
    });
    await r.ingestObservation(SCOPE, {
      workspace: SCOPE.orgId,
      source: "run-stream",
      sourceVersion: 1,
      kind: "gate_result",
      at: fixedClock(),
      dedupeKey: "run:tests:sha256:zz",
      payload: { gate: "tests", revision: "sha256:zz", status: "green" },
    });
    ws = await r.getWorkSet(SCOPE);
    lc = fold(ws).lifecycles[key]!;
    expect(lc.rung).toBe("done");
    expect(lc.evidence).toEqual(["PR o/r#7 merged; gates green"]);
    // observed truth (done) has NOT reached the pin (released): still shown
    expect(lc.pinned?.rung).toBe("released");

    await r.ingestObservation(SCOPE, {
      workspace: SCOPE.orgId,
      source: "deploy-overlay",
      sourceVersion: 1,
      kind: "revision_live",
      at: fixedClock(),
      dedupeKey: "overlay:sha256:zz:production",
      payload: { revision: "sha256:zz", environment: "production" },
    });
    ws = await r.getWorkSet(SCOPE);
    lc = fold(ws).lifecycles[key]!;
    expect(lc.rung).toBe("released");
    expect(lc.pinned).toBeUndefined(); // pin auto-expired on catch-up (invariant 6)
  });
});
