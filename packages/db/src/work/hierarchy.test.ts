// v4 hierarchy conformance (orun-work-v4 WH1): this TypeScript fold replays
// fixtures/hierarchy-conformance.json byte-identically with the Go oracle
// (orun internal/worklens). Do not edit one copy without the other.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  foldDesignIntent,
  foldEpicExecution,
  foldEpicIntent,
  foldInitiativeStatus,
  foldMilestones,
  ladderHash,
} from "./hierarchy.js";
import type { EpicRollup } from "./hierarchy.js";
import {
  EVENT_KINDS,
  HUMAN_ONLY_EVENT_KINDS,
  OBSERVATION_KINDS,
  WorkError,
  fold,
  validateEvent,
  type CoordinationEvent,
  type Health,
  type IntentState,
  type Milestone,
  type Observation,
  type Task,
} from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(here, "fixtures/hierarchy-conformance.json"), "utf8")) as {
  epicIntentCases: {
    name: string;
    epicKey: string;
    events: CoordinationEvent[];
    expect: {
      state: IntentState;
      currentRevision?: string;
      docDrifted?: boolean;
      ladderDrifted?: boolean;
      approval?: { revision?: string; snapshot?: string; by: string };
      milestones?: string[];
    };
  }[];
  designIntentCases: {
    name: string;
    designKey: string;
    events: CoordinationEvent[];
    expect: {
      state: IntentState;
      adoptedRevision?: string;
      minted?: string[];
      adoptedBy?: string;
      supersededBy?: string;
    };
  }[];
  rollupCases: {
    name: string;
    epicKey: string;
    ladderEvents: CoordinationEvent[];
    tasks: Task[];
    events: CoordinationEvent[];
    observations: Observation[];
    expect: {
      milestones: { key: string; total: number; complete: number }[];
      unscheduled?: { total: number; complete: number };
      total: number;
      complete: number;
      blocked: number;
    };
  }[];
  healthCases: {
    name: string;
    initiativeKey: string;
    asOf: string;
    epics: EpicRollup[];
    events: CoordinationEvent[];
    expect: {
      health: Health;
      total?: number;
      complete?: number;
      evidence?: string[];
      pinned?: { health: Health; by: string };
    };
  }[];
};

describe("epic intent conformance (shared with the Go oracle)", () => {
  for (const tc of fixture.epicIntentCases) {
    it(tc.name, async () => {
      const got = await foldEpicIntent(tc.epicKey, tc.events);
      expect(got.state).toBe(tc.expect.state);
      if (tc.expect.currentRevision) expect(got.currentRevision).toBe(tc.expect.currentRevision);
      expect(got.docDrifted ?? false).toBe(tc.expect.docDrifted ?? false);
      expect(got.ladderDrifted ?? false).toBe(tc.expect.ladderDrifted ?? false);
      if (tc.expect.approval) {
        expect(got.approval).toBeDefined();
        expect(got.approval!.revision ?? "").toBe(tc.expect.approval.revision ?? "");
        expect(got.approval!.by.id).toBe(tc.expect.approval.by);
        if (tc.expect.approval.snapshot) expect(got.approval!.snapshot).toBe(tc.expect.approval.snapshot);
      }
      if (tc.expect.milestones) {
        expect((got.milestones ?? []).map((m) => m.key)).toEqual(tc.expect.milestones);
      }
    });
  }
});

describe("design intent conformance", () => {
  for (const tc of fixture.designIntentCases) {
    it(tc.name, () => {
      const got = foldDesignIntent(tc.designKey, tc.events);
      expect(got.state).toBe(tc.expect.state);
      expect(got.adoptedRevision ?? "").toBe(tc.expect.adoptedRevision ?? "");
      if (tc.expect.minted) expect(got.minted).toEqual(tc.expect.minted);
      if (tc.expect.adoptedBy) expect(got.adoptedBy?.id).toBe(tc.expect.adoptedBy);
      expect(got.supersededBy ?? "").toBe(tc.expect.supersededBy ?? "");
    });
  }
});

describe("rollup conformance", () => {
  for (const tc of fixture.rollupCases) {
    it(tc.name, () => {
      const ws = { tasks: tc.tasks, events: tc.events, observations: tc.observations };
      const ladder = foldMilestones(tc.epicKey, tc.ladderEvents);
      const got = foldEpicExecution(ws, tc.epicKey, ladder, fold(ws));
      expect((got.milestones ?? []).map((m) => ({ key: m.key, total: m.total, complete: m.complete }))).toEqual(
        tc.expect.milestones,
      );
      if (tc.expect.unscheduled) {
        expect(got.unscheduled).toBeDefined();
        expect(got.unscheduled!.total).toBe(tc.expect.unscheduled.total);
        expect(got.unscheduled!.complete).toBe(tc.expect.unscheduled.complete);
      } else {
        expect(got.unscheduled).toBeUndefined();
      }
      expect(got.total).toBe(tc.expect.total);
      expect(got.complete).toBe(tc.expect.complete);
      expect(got.blocked).toBe(tc.expect.blocked);
    });
  }
});

describe("initiative health conformance", () => {
  for (const tc of fixture.healthCases) {
    it(tc.name, () => {
      const got = foldInitiativeStatus(tc.initiativeKey, tc.epics, tc.events, tc.asOf);
      expect(got.health).toBe(tc.expect.health);
      if (tc.expect.total) {
        expect(got.total).toBe(tc.expect.total);
        expect(got.complete).toBe(tc.expect.complete ?? 0);
      }
      if (tc.expect.evidence) expect(got.evidence).toEqual(tc.expect.evidence);
      if (tc.expect.pinned) {
        expect(got.pinned).toBeDefined();
        expect(got.pinned!.health).toBe(tc.expect.pinned.health);
        expect(got.pinned!.by.id).toBe(tc.expect.pinned.by);
      } else {
        expect(got.pinned).toBeUndefined();
      }
    });
  }
});

describe("the v4 vocabulary and guards", () => {
  it("grows to 27 coordination kinds; observations stay frozen at 6 (V4-1)", () => {
    expect(EVENT_KINDS.length).toBe(27);
    expect(OBSERVATION_KINDS.length).toBe(6);
  });

  it("still has no delivery-lifecycle-write kind (WP-3)", () => {
    for (const k of EVENT_KINDS) {
      expect(["status_changed", "lifecycle_changed", "rung_set", "status_set"]).not.toContain(k);
    }
  });

  it("rejects agents AND automation on human-only decisions (V4-2)", () => {
    for (const kind of HUMAN_ONLY_EVENT_KINDS) {
      for (const type of ["agent", "automation"] as const) {
        expect(() =>
          validateEvent({
            workspace: "ws",
            subject: "some-epic",
            kind,
            actor: { type, id: "sp_1" },
            at: "2026-07-11T00:00:00Z",
            seq: 1,
          }),
        ).toThrowError(WorkError);
      }
      expect(() =>
        validateEvent({
          workspace: "ws",
          subject: "some-epic",
          kind,
          actor: { type: "user", id: "usr_1" },
          at: "2026-07-11T00:00:00Z",
          seq: 1,
        }),
      ).not.toThrow();
    }
  });

  it("accepts agents on non-decision v4 kinds (reviews are advice)", () => {
    for (const kind of ["milestone_edited", "milestone_set", "review_requested", "review_submitted"] as const) {
      expect(() =>
        validateEvent({
          workspace: "ws",
          subject: "some-epic",
          kind,
          actor: { type: "agent", id: "sp_1" },
          at: "2026-07-11T00:00:00Z",
          seq: 1,
        }),
      ).not.toThrow();
    }
  });
});

describe("ladderHash", () => {
  it("is deterministic and order/content sensitive (matches the Go oracle shape)", async () => {
    const a: Milestone[] = [
      { key: "M1", title: "One", ordinal: 0 },
      { key: "M2", title: "Two", ordinal: 1 },
    ];
    const b: Milestone[] = [
      { key: "M1", title: "One", ordinal: 0 },
      { key: "M2", title: "Two", ordinal: 1 },
    ];
    expect(await ladderHash(a)).toBe(await ladderHash(b));
    const c: Milestone[] = [
      { key: "M1", title: "One (renamed)", ordinal: 0 },
      { key: "M2", title: "Two", ordinal: 1 },
    ];
    expect(await ladderHash(a)).not.toBe(await ladderHash(c));
    expect(await ladderHash([])).toBe(await ladderHash([]));
  });
});
