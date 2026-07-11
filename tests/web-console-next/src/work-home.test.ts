// Work home model tests (orun-work-v5 WV1) — the pure lens/stat/grouping
// projections behind the one-home-three-lenses surface. Everything here is
// a projection of the summary fold; none of it computes an enterable value.

import type { WorkSpecView, WorkTaskView } from "@saas/contracts/work";
import {
  EPIC_GROUP_ORDER,
  attentionCount,
  epicCountLabel,
  epicGroups,
  openTaskCount,
  parseLens,
  progressTotals,
  targetLabel,
} from "@web-console-next/lib/work/home";

function task(rung: WorkTaskView["lifecycle"]["rung"]): WorkTaskView {
  return {
    key: `t-${rung}`,
    title: rung,
    createdBy: { type: "user", id: "usr_1" },
    lifecycle: { rung, ready: false, blocked: false },
  } as WorkTaskView;
}

function spec(key: string, state?: string): WorkSpecView {
  return {
    key,
    title: key,
    createdBy: { type: "user", id: "usr_1" },
    progress: {},
    ...(state ? { intent: { state } } : {}),
  } as WorkSpecView;
}

describe("parseLens", () => {
  it("accepts the three lenses and rejects everything else", () => {
    expect(parseLens("initiatives")).toBe("initiatives");
    expect(parseLens("epics")).toBe("epics");
    expect(parseLens("tasks")).toBe("tasks");
    expect(parseLens("board")).toBeNull();
    expect(parseLens(null)).toBeNull();
  });
});

describe("header stats", () => {
  it("open = not released, not canceled (matches the workbench stat)", () => {
    const tasks = [task("draft"), task("in_progress"), task("done"), task("released"), task("canceled")];
    expect(openTaskCount(tasks)).toBe(3);
  });

  it("need attention = the triage queue length (drift + suggestions)", () => {
    expect(attentionCount({ drift: [{}, {}], suggestions: [{}] })).toBe(3);
    expect(attentionCount({ drift: [], suggestions: [] })).toBe(0);
  });
});

describe("row projections", () => {
  it("epic count label handles the singular", () => {
    expect(epicCountLabel(1)).toBe("1 epic");
    expect(epicCountLabel(2)).toBe("2 epics");
    expect(epicCountLabel(0)).toBe("0 epics");
  });

  it("progress totals exclude canceled from the denominator", () => {
    expect(progressTotals({ done: 2, released: 1, in_progress: 1, canceled: 5 })).toEqual({
      total: 4,
      done: 3,
    });
    expect(progressTotals(undefined)).toEqual({ total: 0, done: 0 });
  });

  it("target labels: same-year stays concrete, far years round to quarters", () => {
    const now = new Date("2026-07-11T00:00:00Z");
    expect(targetLabel("2026-08-30", now)).toBe("Aug 30");
    expect(targetLabel("2027-08-02", now)).toBe("Q3 2027");
    expect(targetLabel("2027-01-15", now)).toBe("Q1 2027");
    expect(targetLabel(undefined, now)).toBe("—");
    expect(targetLabel("Q3 2026", now)).toBe("Q3 2026"); // non-ISO passes through
  });
});

describe("epicGroups (§3.2)", () => {
  it("groups by intent state in ladder order, drifted first, keys sorted", () => {
    const groups = epicGroups([
      spec("b-epic", "approved"),
      spec("a-epic", "approved"),
      spec("c-epic", "approved_drifted"),
      spec("d-epic", "in_review"),
      spec("e-epic"), // no intent → draft
    ]);
    expect(groups.map((g) => g.state)).toEqual(["approved_drifted", "approved", "in_review", "draft"]);
    expect(groups[1]!.specs.map((s) => s.key)).toEqual(["a-epic", "b-epic"]);
    expect(EPIC_GROUP_ORDER[0]).toBe("approved_drifted");
  });

  it("drops empty groups and keeps unknown states visible", () => {
    const groups = epicGroups([spec("x", "some_future_state")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.state).toBe("some_future_state");
  });
});
