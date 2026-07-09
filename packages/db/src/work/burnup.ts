// The derived burn-up (orun-work-v3 PM3, V3-3): a cycle's progress series
// computed by replaying BOTH logs day by day — scope is how many tasks were
// planned into the cycle by each date, done is how many of those the fold
// had folded to done/released by that date. There is no stored series and
// no setter anywhere in this module; the first progress chart that can't be
// gamed by moving cards on a Friday, because there are no cards to move —
// only facts that arrived or didn't. Carry-over renders as the gap between
// the two lines at the window's end.

import { buildEnvelopes } from "./envelopes.js";
import { fold, type WorkSet } from "./model.js";

export interface BurnupPoint {
  date: string; // ISO date (the day's end is the replay cutoff)
  scope: number; // tasks planned into the cycle as of this date
  done: number; // of those, folded done/released as of this date
}

const DAY_MS = 86_400_000;

function dateOnly(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
}

/** Replays the workspace as of each day in [startsAt, endsAt] (inclusive,
 *  optionally capped at `until` — pass "today" so future days render as
 *  nothing rather than a flat line) and folds a scope/done point per day.
 *  Pure and deterministic: same logs, same series, every machine. */
export function burnup(
  ws: WorkSet,
  cycle: { key: string; startsAt: string; endsAt: string },
  until?: string,
): BurnupPoint[] {
  const start = dateOnly(cycle.startsAt);
  let end = dateOnly(cycle.endsAt);
  if (until !== undefined) end = Math.min(end, dateOnly(until));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const points: BurnupPoint[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    const cutoff = `${date}T23:59:59.999Z`;
    const events = ws.events.filter((e) => e.at <= cutoff);
    const observations = ws.observations.filter((o) => o.at <= cutoff);
    const { tasks } = buildEnvelopes("burnup", events);
    const members = tasks.filter((task) => task.cycleKey === cycle.key);
    const r = fold({ tasks, events, observations });
    const done = members.filter((task) => {
      const rung = r.lifecycles[task.key]?.rung;
      return rung === "done" || rung === "released";
    }).length;
    points.push({ date, scope: members.length, done });
  }
  return points;
}
