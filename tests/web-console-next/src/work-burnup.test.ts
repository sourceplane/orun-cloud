// Burn-up geometry tests (orun-work-v3 PM3) — the pure lib only. The series
// itself is derived server-side; this module just maps it to coordinates,
// so the tests pin the mapping: baseline at the bottom, scope high-water as
// the y-max, single-day cycles at x=0, carry-over as the end gap.

import type { WorkBurnupPoint } from "@saas/contracts/work";
import { burnupGeometry, carryOver } from "@web-console-next/lib/work/burnup";

const SERIES: WorkBurnupPoint[] = [
  { date: "2026-07-01", scope: 1, done: 0 },
  { date: "2026-07-02", scope: 2, done: 0 },
  { date: "2026-07-03", scope: 2, done: 1 },
];

describe("burnupGeometry", () => {
  it("maps points across the width with y=0 on the baseline", () => {
    const g = burnupGeometry(SERIES, 100, 50)!;
    expect(g.maxY).toBe(2);
    expect(g.points.map((p) => p.x)).toEqual([0, 50, 100]);
    // scope: 1/2 → y=25, 2/2 → y=0; done: 0 → y=50 (baseline), 1/2 → y=25
    expect(g.scopeLine).toBe("0,25 50,0 100,0");
    expect(g.doneLine).toBe("0,50 50,50 100,25");
    expect(g.doneArea.startsWith("M 0,50")).toBe(true);
    expect(g.doneArea.endsWith("Z")).toBe(true);
  });

  it("renders a single-day cycle at x=0 and an empty series as null", () => {
    const g = burnupGeometry([{ date: "2026-07-01", scope: 3, done: 3 }], 100, 50)!;
    expect(g.points).toHaveLength(1);
    expect(g.points[0]!.x).toBe(0);
    expect(g.points[0]!.yDone).toBe(0); // all done → top
    expect(burnupGeometry([], 100, 50)).toBeNull();
  });

  it("an empty cycle still renders (maxY floors at 1)", () => {
    const g = burnupGeometry([{ date: "2026-07-01", scope: 0, done: 0 }], 100, 50)!;
    expect(g.maxY).toBe(1);
    expect(g.points[0]!.yScope).toBe(50); // zero sits on the baseline
  });
});

describe("carryOver", () => {
  it("is the end-of-window gap between scope and done", () => {
    expect(carryOver(SERIES)).toBe(1);
    expect(carryOver([{ date: "2026-07-01", scope: 2, done: 2 }])).toBe(0);
    expect(carryOver([])).toBe(0);
  });
});
