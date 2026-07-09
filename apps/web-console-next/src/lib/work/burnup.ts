// Pure geometry for the burn-up chart (orun-work-v3 PM3; unit-tested, no
// React). The series is DERIVED — the fold replayed day by day — so this
// module only maps points to coordinates; there is nothing here (or
// anywhere) that could write one.

import type { WorkBurnupPoint } from "@saas/contracts/work";

export interface BurnupGeometry {
  /** SVG polyline `points` strings. */
  scopeLine: string;
  doneLine: string;
  /** Closed path under the done line (the filled area). */
  doneArea: string;
  /** y-axis max (scope high-water mark, min 1 so an empty cycle renders). */
  maxY: number;
  /** Per-point x/y for hover targets and end labels. */
  points: Array<{ x: number; yScope: number; yDone: number; point: WorkBurnupPoint }>;
}

/** Maps a derived burn-up series into a width×height viewBox. A single-day
 *  cycle renders its point at x=0; y=0 sits on the baseline (bottom). */
export function burnupGeometry(series: WorkBurnupPoint[], width: number, height: number): BurnupGeometry | null {
  if (series.length === 0) return null;
  const maxY = Math.max(1, ...series.map((p) => p.scope));
  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  const y = (v: number) => height - (v / maxY) * height;
  const points = series.map((point, i) => ({
    x: Math.round(i * stepX * 100) / 100,
    yScope: Math.round(y(point.scope) * 100) / 100,
    yDone: Math.round(y(point.done) * 100) / 100,
    point,
  }));
  const scopeLine = points.map((p) => `${p.x},${p.yScope}`).join(" ");
  const doneLine = points.map((p) => `${p.x},${p.yDone}`).join(" ");
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const doneArea = `M ${first.x},${height} L ${points.map((p) => `${p.x},${p.yDone}`).join(" L ")} L ${last.x},${height} Z`;
  return { scopeLine, doneLine, doneArea, maxY, points };
}

/** The carry-over readout: what the window ended with that the facts never
 *  confirmed — rendered as a gap, never "moved by hand" to the next cycle. */
export function carryOver(series: WorkBurnupPoint[]): number {
  const last = series[series.length - 1];
  return last ? Math.max(0, last.scope - last.done) : 0;
}
