import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_KINDS,
  WorkError,
  contractComplete,
  fold,
  progress,
  taskKeysIn,
  validateEvent,
  validateObservation,
  type CoordinationEvent,
  type FoldResult,
  type Observation,
  type Rung,
  type Task,
  type WorkSet,
} from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));

interface FixtureCase {
  name: string;
  workspace: string;
  tasks: Task[];
  events: CoordinationEvent[];
  observations: Observation[];
  expect: {
    lifecycles: Record<
      string,
      { rung: Rung; ready: boolean; blocked: boolean; evidence?: string[]; pinned?: { rung: Rung; by: string } }
    >;
    drift?: Array<{ pr: string; affected: string[] }>;
    suggestions?: Array<{ pr: string; taskKeys: string[] }>;
  };
}

const fixture = JSON.parse(readFileSync(resolve(here, "fixtures/conformance.json"), "utf8")) as {
  cases: FixtureCase[];
};

describe("fold conformance (mirrors the Go oracle byte-for-byte)", () => {
  it("has cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const tc of fixture.cases) {
    it(tc.name, () => {
      const got: FoldResult = fold({ tasks: tc.tasks, events: tc.events, observations: tc.observations });

      expect(Object.keys(got.lifecycles).length).toBe(tc.tasks.length);
      for (const [key, want] of Object.entries(tc.expect.lifecycles)) {
        const lc = got.lifecycles[key]!;
        expect(lc, `lifecycle for ${key}`).toBeDefined();
        expect(lc.rung, `${key} rung`).toBe(want.rung);
        expect(lc.ready, `${key} ready`).toBe(want.ready);
        expect(lc.blocked, `${key} blocked`).toBe(want.blocked);
        if (want.evidence) {
          expect(lc.evidence, `${key} evidence`).toEqual(want.evidence);
        }
        if (want.pinned) {
          expect(lc.pinned, `${key} pinned`).toBeDefined();
          expect(lc.pinned?.rung).toBe(want.pinned.rung);
          expect(lc.pinned?.by.id).toBe(want.pinned.by);
        } else {
          expect(lc.pinned, `${key} should not be pinned`).toBeUndefined();
        }
      }

      expect(got.drift ?? []).toEqual(tc.expect.drift ?? []);
      expect(
        (got.suggestions ?? []).map((s) => ({ pr: s.pr, taskKeys: s.taskKeys })),
      ).toEqual(tc.expect.suggestions ?? []);
    });
  }

  it("is deterministic (droppable-cache guarantee, invariant 1)", () => {
    for (const tc of fixture.cases) {
      const ws: WorkSet = { tasks: tc.tasks, events: tc.events, observations: tc.observations };
      expect(JSON.stringify(fold(ws))).toBe(JSON.stringify(fold(ws)));
    }
  });
});

describe("write-time validation", () => {
  const base: CoordinationEvent = {
    workspace: "ws",
    subject: "ORN-1",
    kind: "comment_added",
    actor: { type: "user", id: "usr_1" },
    at: "2026-07-02T09:00:00Z",
    seq: 1,
  };

  it("accepts a valid event and rejects the invariants' violations", () => {
    expect(() => validateEvent(base)).not.toThrow();
    expect(() => validateEvent({ ...base, actor: undefined as never })).toThrow(WorkError);
    expect(() => validateEvent({ ...base, subject: "" })).toThrow(WorkError);
    expect(() => validateEvent({ ...base, kind: "status_changed" as never })).toThrow(WorkError);
  });

  it("has no lifecycle write kind (WP-3: the lie is unrepresentable)", () => {
    expect(EVENT_KINDS).not.toContain("status_changed");
    expect(EVENT_KINDS).not.toContain("lifecycle_changed");
  });

  it("rejects agent pins (WP-10) but allows human pins", () => {
    const pin: CoordinationEvent = { ...base, kind: "pinned", payload: { rung: "done" } };
    expect(() => validateEvent({ ...pin, actor: { type: "agent", id: "sp_1" } })).toThrow(WorkError);
    expect(() => validateEvent({ ...pin, actor: { type: "user", id: "usr_1" } })).not.toThrow();
  });

  it("requires observations to be sourced, versioned, and deduped", () => {
    const obs: Observation = {
      workspace: "ws",
      source: "github-webhook",
      sourceVersion: 1,
      kind: "pr_opened",
      at: "2026-07-02T09:00:00Z",
      dedupeKey: "gh:pr:o/r#1:opened",
      seq: 1,
    };
    expect(() => validateObservation(obs)).not.toThrow();
    expect(() => validateObservation({ ...obs, kind: "deploy_attempted" as never })).toThrow(WorkError);
    expect(() => validateObservation({ ...obs, source: "" })).toThrow(WorkError);
    expect(() => validateObservation({ ...obs, sourceVersion: 0 })).toThrow(WorkError);
    expect(() => validateObservation({ ...obs, dedupeKey: "" })).toThrow(WorkError);
  });
});

describe("contract + keys", () => {
  it("derives Ready from completeness with declared gates", () => {
    expect(contractComplete(undefined)).toBe(false);
    expect(contractComplete({})).toBe(false);
    expect(contractComplete({ goal: "g", affects: ["a/b/c"], doneWhen: ["d"], gates: ["tests"] })).toBe(true);
    expect(contractComplete({ goal: "g", affects: ["a/b/c"], doneWhen: ["d"], gatesDefined: true })).toBe(true);
    expect(contractComplete({ goal: "g", affects: ["a/b/c"], doneWhen: ["d"] })).toBe(false);
  });

  it("parses task keys out of free text in first-appearance order", () => {
    expect(taskKeysIn("feat/ORN-3-wire lands WP0 with ORN-12 and ORN-3 again")).toEqual(["ORN-3", "ORN-12"]);
  });
});

describe("progress", () => {
  it("folds one spec's tasks into rung counts", () => {
    const tasks: Task[] = [
      { apiVersion: "orun.io/v1", kind: "Task", key: "ORN-1", workspace: "ws", spec: "a", title: "x", createdBy: { type: "user", id: "u" } },
      { apiVersion: "orun.io/v1", kind: "Task", key: "ORN-2", workspace: "ws", spec: "a", title: "y", contract: { goal: "g", affects: ["p/q/r"], doneWhen: ["d"], gates: ["tests"] }, createdBy: { type: "user", id: "u" } },
      { apiVersion: "orun.io/v1", kind: "Task", key: "ORN-3", workspace: "ws", spec: "b", title: "z", createdBy: { type: "user", id: "u" } },
    ];
    const ws: WorkSet = { tasks, events: [], observations: [] };
    const counts = progress(ws, "a", fold(ws));
    expect(counts).toEqual({ draft: 1, ready: 1 });
  });
});
