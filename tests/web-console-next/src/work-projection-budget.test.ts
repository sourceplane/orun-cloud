// The WV6 projection budget (orun-work-v5): the pure lens projections —
// grouping, meters, targets — over a corpus well beyond the dogfood tree
// (50 initiatives · 60 epics · 600 tasks) must stay far under one frame.
// Budget-gated generously for CI variance; the measured numbers are
// recorded in specs/epics/orun-work-v5/implementation-plan.md. End-to-end
// interaction profiling of the deployed console rides the live dogfood
// pass, same as v4's fold budget did.

import type { WorkRung, WorkSpecView, WorkTaskView } from "@saas/contracts/work";
import {
  epicGroups,
  progressTotals,
  targetLabel,
  taskGroups,
} from "@web-console-next/lib/work/home";
import { meterSegments } from "@web-console-next/lib/work/rungs";

const RUNGS: WorkRung[] = ["draft", "ready", "in_progress", "in_review", "done", "released"];
const STATES = ["draft", "in_review", "approved", "approved_drifted"] as const;

function corpus(): { specs: WorkSpecView[]; tasks: WorkTaskView[] } {
  const specs: WorkSpecView[] = [];
  const tasks: WorkTaskView[] = [];
  for (let e = 0; e < 60; e++) {
    specs.push({
      key: `epic-${e}`,
      title: `Epic ${e}`,
      createdBy: { type: "user", id: "usr_1" },
      progress: { done: e % 5, in_progress: e % 3, draft: e % 4 },
      intent: { state: STATES[e % STATES.length]! },
      initiative: `init-${e % 50}`,
      targetDate: `202${6 + (e % 2)}-0${(e % 9) + 1}-15`,
    } as WorkSpecView);
    for (let t = 0; t < 10; t++) {
      tasks.push({
        key: `t-${e}-${t}`,
        title: `Task ${e}.${t}`,
        spec: `epic-${e}`,
        createdBy: { type: "user", id: "usr_1" },
        priority: t % 2 ? "high" : "none",
        lifecycle: {
          rung: RUNGS[(e + t) % RUNGS.length]!,
          ready: true,
          blocked: false,
          ...(t % 7 === 0 ? { pinned: { rung: "done" as const, by: { type: "user" as const, id: "u" } } } : {}),
        },
      } as WorkTaskView);
    }
  }
  return { specs, tasks };
}

describe("WV6 — lens projections stay under budget at 10× dogfood scale", () => {
  it("groups + meters + labels for 600 tasks / 60 epics in one pass < 100ms", () => {
    const { specs, tasks } = corpus();
    const now = new Date("2026-07-11T00:00:00Z");
    const start = performance.now();
    const tg = taskGroups(tasks);
    const eg = epicGroups(specs);
    for (const s of specs) {
      const { total } = progressTotals(s.progress);
      meterSegments(s.progress, total);
      targetLabel(s.targetDate, now);
    }
    const elapsed = performance.now() - start;
    expect(tg.reduce((n, g) => n + g.tasks.length, 0)).toBe(600);
    expect(eg.reduce((n, g) => n + g.specs.length, 0)).toBe(60);
    // Measured ~2–6ms on the CI class of machine; gated at 100ms.
    expect(elapsed).toBeLessThan(100);
  });
});
