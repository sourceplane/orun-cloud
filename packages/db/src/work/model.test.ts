import { describe, expect, it } from "vitest";
import {
  EVENT_KINDS,
  WorkError,
  WorkProjection,
  agentReady,
  contractComplete,
  isEventKind,
  validateEvent,
  type Actor,
  type WorkEvent,
} from "./model.js";

// A deterministic id minter so the live and replayed projections are built from
// identical events (the eventId/itemId live inside the events themselves).
function seqMinter(): (p: string) => string {
  let n = 0;
  return (prefix: string) => `${prefix}${(n++).toString().padStart(6, "0")}`;
}

const human: Actor = { type: "user", id: "prn_human", via: "ui" };
const auto: Actor = { type: "automation", id: "bridge/pr-linker", via: "github-webhook" };
const AT = "2026-06-11T09:00:00Z";

function exerciseEveryKind(s: WorkProjection): WorkEvent[] {
  const log: WorkEvent[] = [];
  log.push(s.createInitiative("portal-ga", "Portal GA", {}, human, AT));
  log.push(s.createEpic("orun-work", "Orun Work", { doc: "# spec body" }, human, AT));
  log.push(
    s.createTask(
      "Route catalog reads",
      {
        parent: "acme/platform/epics/orun-work",
        contract: { goal: "g", affects: ["sourceplane/orun/api-edge"], doneWhen: ["parity"], gates: ["tests"] },
      },
      human,
      AT,
    ),
  );
  log.push(s.editItem("ORN-1", "Route catalog reads (v2)", undefined, human, AT));
  log.push(s.setStatus("ORN-1", "in_progress", undefined, human, AT));
  log.push(s.assign("ORN-1", "prn_a", human, AT));
  log.push(s.assign("ORN-1", "prn_b", human, AT));
  log.push(s.unassign("ORN-1", "prn_a", human, AT));
  log.push(s.addComment("ORN-1", "looks good", human, AT));
  log.push(
    s.addLink({ from: "ORN-1", fromKind: "Task", type: "implementedBy", to: "sourceplane/orun#412", toKind: "pr" }, auto, AT),
  );
  log.push(s.removeLink({ from: "ORN-1", type: "implementedBy", to: "sourceplane/orun#412" }, auto, AT));
  log.push(s.editContract("ORN-1", { goal: "narrowed goal" }, human, AT));
  log.push(s.move("ORN-1", "acme/platform/epics/orun-work", 1.5, human, AT));
  log.push(s.setCycle("ORN-1", "2026-W24", human, AT));
  log.push(s.label("ORN-1", "area", "catalog", human, AT));
  log.push(s.unlabel("ORN-1", "area", human, AT));
  log.push(s.seal("orun-work", "sha256:abc123", "refs/work/epics/orun-work/latest", 99, auto, AT));
  log.push(s.import({ apiVersion: "orun.io/v1", kind: "Task", id: "tsk_x", key: "ORN-99", project: "acme/platform", title: "Imported", createdBy: auto, createdAt: AT }, "specs/", auto, AT));
  log.push(s.cancel("ORN-1", "superseded", human, AT));
  return log;
}

describe("work model — invariant 2 (replay reproduces the projection)", () => {
  it("replays an all-kinds log into a byte-for-byte identical projection", () => {
    const live = new WorkProjection("acme/platform", "ORN", seqMinter());
    const log = exerciseEveryKind(live);

    // Every closed-set kind must have been produced.
    const seen = new Set(log.map((e) => e.kind));
    for (const k of EVENT_KINDS) {
      expect(seen.has(k), `event kind ${k} was never exercised`).toBe(true);
    }

    const replayed = WorkProjection.reduce("acme/platform", "ORN", log, seqMinter());

    expect(JSON.stringify(replayed.projectionSnapshot())).toEqual(JSON.stringify(live.projectionSnapshot()));

    const row = replayed.status.get("ORN-1");
    expect(row?.status).toBe("canceled");
    expect(row?.assignees).toEqual(["prn_b"]);
    expect(row?.boardOrder).toBe(1.5);
    const it = replayed.items.get("ORN-1");
    expect(it?.cycle).toBe("2026-W24");
    expect(it?.labels).toBeUndefined();
    expect(it?.contract?.goal).toBe("narrowed goal");
  });

  it("assigns one seq per mutation, monotonically", () => {
    const s = new WorkProjection("acme/platform", "ORN", seqMinter());
    const first = s.createTask("first", {}, human, AT);
    expect(first.seq).toBe(1);
    const before = s.nextSeq();
    s.setStatus("ORN-1", "todo", undefined, human, AT);
    expect(s.nextSeq()).toBe(before + 1);
  });
});

describe("work model — actor + event guards", () => {
  it("rejects a mutation with no actor and does not advance the sequence", () => {
    const s = new WorkProjection("acme/platform", "ORN", seqMinter());
    expect(() => s.createTask("x", {}, { type: "user", id: "" }, AT)).toThrow(WorkError);
    expect(s.nextSeq()).toBe(1);
  });

  it("rejects an actor-less event on the replay path", () => {
    const bad: WorkEvent = { eventId: "wev_x", project: "acme/platform", subject: "ORN-1", kind: "status_changed", actor: { type: "user", id: "" }, at: AT, seq: 1 };
    expect(() => validateEvent(bad)).toThrow(/actor/);
    expect(() => WorkProjection.reduce("acme/platform", "ORN", [bad], seqMinter())).toThrow(WorkError);
  });

  it("rejects an unknown event kind", () => {
    expect(isEventKind("teleported")).toBe(false);
    const bad = { eventId: "wev_x", project: "p", subject: "ORN-1", kind: "teleported", actor: human, at: AT, seq: 1 } as unknown as WorkEvent;
    expect(() => validateEvent(bad)).toThrow(/unknown event kind/);
  });

  it("rejects a status_changed for a missing entity on replay", () => {
    const ev: WorkEvent = {
      eventId: "wev_x",
      project: "acme/platform",
      subject: "ORN-7",
      kind: "status_changed",
      actor: human,
      at: AT,
      payload: { from: "backlog", to: "todo" },
      seq: 1,
    };
    expect(() => WorkProjection.reduce("acme/platform", "ORN", [ev], seqMinter())).toThrow(/not_found|ORN-7/);
  });
});

describe("work model — mutator validation", () => {
  it("allocates sequential task keys and restores the counter on replay", () => {
    const s = new WorkProjection("acme/platform", "ORN", seqMinter());
    expect(s.createTask("a", {}, human, AT).subject).toBe("ORN-1");
    expect(s.createTask("b", {}, human, AT).subject).toBe("ORN-2");
    // A foreign-prefix import must not move the local counter.
    s.import({ apiVersion: "orun.io/v1", kind: "Task", id: "tsk_z", key: "XYZ-9", project: "acme/platform", title: "foreign", createdBy: auto, createdAt: AT }, "s", auto, AT);
    expect(s.createTask("c", {}, human, AT).subject).toBe("ORN-3");
  });

  it("enforces argument and existence rules", () => {
    const s = new WorkProjection("acme/platform", "ORN", seqMinter());
    expect(() => s.createTask("", {}, human, AT)).toThrow(/title/);
    expect(() => s.createEpic("Bad Slug", "t", {}, human, AT)).toThrow(/slug/);
    expect(() => s.createEpic("e", "t", { contract: {} }, human, AT)).toThrow(/contract/);
    s.createEpic("dup", "first", {}, human, AT);
    expect(() => s.createEpic("dup", "second", {}, human, AT)).toThrow(/conflict|exists/);
    expect(() => s.setStatus("ORN-9", "todo", undefined, human, AT)).toThrow(/not_found|ORN-9/);
    expect(() => s.setStatus("dup", "teleported" as never, undefined, human, AT)).toThrow(/closed set/);
    s.createTask("t", {}, human, AT);
    expect(() => s.editContract("dup", {}, human, AT)).toThrow(/only Tasks/);
    expect(() => s.addLink({ from: "ORN-1", fromKind: "Task", type: "ghost" as never, to: "x", toKind: "pr" }, human, AT)).toThrow(/vocabulary/);
  });

  it("clears an empty label map and dedups assignees", () => {
    const s = new WorkProjection("acme/platform", "ORN", seqMinter());
    s.createTask("t", {}, human, AT);
    for (const p of ["prn_c", "prn_a", "prn_c", "prn_b"]) s.assign("ORN-1", p, human, AT);
    expect(s.status.get("ORN-1")?.assignees).toEqual(["prn_a", "prn_b", "prn_c"]);
    s.label("ORN-1", "area", "catalog", human, AT);
    expect(s.items.get("ORN-1")?.labels).toEqual({ area: "catalog" });
    s.unlabel("ORN-1", "area", human, AT);
    expect(s.items.get("ORN-1")?.labels).toBeUndefined();
  });
});

describe("work model — contract derivation", () => {
  it("derives completeness and agent-readiness", () => {
    expect(contractComplete(undefined)).toBe(false);
    const full = { goal: "g", affects: ["a/b/c"], doneWhen: ["d"], gates: ["tests"] };
    expect(contractComplete(full)).toBe(true);
    expect(contractComplete({ goal: "g" })).toBe(false);
    expect(agentReady(full)).toBe(true);
    expect(agentReady(full, () => false)).toBe(false);
    expect(agentReady(full, () => true)).toBe(true);
    expect(agentReady({ goal: "g" })).toBe(false);
  });
});
