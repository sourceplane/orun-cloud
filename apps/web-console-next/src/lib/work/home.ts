// Pure presentation model for the Work home (orun-work-v5 WV1;
// unit-tested, no React). One home, three lenses; everything here is a
// projection of the summary fold — nothing computes a value a user could
// enter (WV-2).

import type {
  WorkCycleView,
  WorkIntentState,
  WorkRung,
  WorkSpecView,
  WorkTaskView,
} from "@saas/contracts/work";
import { boardRung, PRIORITY_ORDER } from "@/lib/work/board";

export type WorkLens = "initiatives" | "epics" | "tasks";

export const WORK_LENSES: readonly WorkLens[] = ["initiatives", "epics", "tasks"];

export function parseLens(value: string | null | undefined): WorkLens | null {
  return (WORK_LENSES as readonly string[]).includes(value ?? "") ? (value as WorkLens) : null;
}

/** Open = not landed, not authored-away (matches the workbench stat). */
export function openTaskCount(tasks: readonly WorkTaskView[]): number {
  return tasks.filter((t) => t.lifecycle.rung !== "released" && t.lifecycle.rung !== "canceled").length;
}

/** The `need attention` stat is the triage queue's length: approval drift
 *  plus fold suggestions awaiting a human decision. */
export function attentionCount(summary: {
  drift: readonly unknown[];
  suggestions: readonly unknown[];
}): number {
  return summary.drift.length + summary.suggestions.length;
}

export function epicCountLabel(n: number): string {
  return n === 1 ? "1 epic" : `${n} epics`;
}

/** Totals over a derived per-rung projection (canceled never counts). */
export function progressTotals(progress: Partial<Record<WorkRung, number>> | undefined): {
  total: number;
  done: number;
} {
  let total = 0;
  let done = 0;
  for (const [rung, n] of Object.entries(progress ?? {})) {
    if (rung === "canceled") continue;
    total += n ?? 0;
    if (rung === "done" || rung === "released") done += n ?? 0;
  }
  return { total, done };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Target column label (§3.1): near targets stay concrete ("Aug 30"), far
 * targets round to the quarter ("Q3 2027") — the mock's grammar. `now`
 * is a parameter so the projection stays pure.
 */
export function targetLabel(dateStr: string | undefined, now: Date): string {
  if (!dateStr) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year === now.getFullYear()) return `${MONTHS[month - 1]} ${day}`;
  return `Q${Math.floor((month - 1) / 3) + 1} ${year}`;
}

/** Epics-lens grouping: intent states in ladder order, drifted first —
 *  the states that need a human lead (§3.2). Empty groups are dropped. */
export const EPIC_GROUP_ORDER: readonly WorkIntentState[] = [
  "approved_drifted",
  "approved",
  "in_review",
  "draft",
  "superseded",
  "canceled",
];

export interface EpicGroup {
  state: WorkIntentState;
  specs: WorkSpecView[];
}

export function epicGroups(specs: readonly WorkSpecView[]): EpicGroup[] {
  const byState = new Map<WorkIntentState, WorkSpecView[]>();
  for (const spec of specs) {
    const state = spec.intent?.state ?? "draft";
    const list = byState.get(state) ?? [];
    list.push(spec);
    byState.set(state, list);
  }
  const groups: EpicGroup[] = [];
  for (const state of EPIC_GROUP_ORDER) {
    const list = byState.get(state);
    if (list?.length) groups.push({ state, specs: [...list].sort((a, b) => (a.key < b.key ? -1 : 1)) });
    byState.delete(state);
  }
  // Unknown/future states render rather than vanish (truth over tidiness).
  for (const [state, list] of byState) groups.push({ state, specs: list });
  return groups;
}

/* ── Tasks lens (§3.3) ──────────────────────────────────────────────── */

/** Tasks-lens group order: the day's active work first, the landed tail
 *  last (the mock's order — deliberately not ladder order). */
export const TASK_GROUP_ORDER: readonly WorkRung[] = [
  "in_progress",
  "in_review",
  "ready",
  "draft",
  "done",
  "released",
  "canceled",
];

export interface TaskGroup {
  rung: WorkRung;
  tasks: WorkTaskView[];
}

/** Groups by the board position (a pinned task sits in its pinned group —
 *  the badge beside truth tells the reader the fold disagrees), sorted by
 *  priority then key. Empty groups are dropped. */
export function taskGroups(tasks: readonly WorkTaskView[]): TaskGroup[] {
  const byRung = new Map<WorkRung, WorkTaskView[]>();
  for (const t of tasks) {
    const rung = boardRung(t);
    const list = byRung.get(rung) ?? [];
    list.push(t);
    byRung.set(rung, list);
  }
  const groups: TaskGroup[] = [];
  for (const rung of TASK_GROUP_ORDER) {
    const list = byRung.get(rung);
    if (!list?.length) continue;
    groups.push({
      rung,
      tasks: [...list].sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority ?? "none"];
        const pb = PRIORITY_ORDER[b.priority ?? "none"];
        if (pa !== pb) return pa - pb;
        return a.key < b.key ? -1 : 1;
      }),
    });
  }
  return groups;
}

/* ── The cycle bar (§3.3) ───────────────────────────────────────────── */

export interface CycleBarModel {
  key: string;
  name: string;
  /** "Jul 1 – Jul 14" */
  rangeLabel: string;
  /** Derived completion percent of the cycle's scope. */
  pct: number;
  /** "62% complete · 3 days left" */
  statusLabel: string;
}

function utcDayLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The cycle whose window contains `now` (latest start wins on overlap). */
export function activeCycle(cycles: readonly WorkCycleView[], now: Date): WorkCycleView | null {
  let best: WorkCycleView | null = null;
  for (const c of cycles) {
    const start = new Date(c.startsAt).getTime();
    const end = new Date(c.endsAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (start <= now.getTime() && now.getTime() <= end) {
      if (!best || new Date(best.startsAt).getTime() < start) best = c;
    }
  }
  return best;
}

/** Pure projection for the Tasks-lens cycle bar — scope and done are the
 *  fold's numbers riding WorkCycleView (V3-3); only labels happen here. */
export function cycleBarModel(cycle: WorkCycleView, now: Date): CycleBarModel {
  const start = new Date(cycle.startsAt);
  const end = new Date(cycle.endsAt);
  const pct = cycle.scope > 0 ? Math.round((cycle.done / cycle.scope) * 100) : 0;
  const msLeft = end.getTime() - now.getTime();
  const daysLeft = Math.ceil(msLeft / 86_400_000);
  const left = daysLeft > 1 ? `${daysLeft} days left` : daysLeft === 1 ? "last day" : "ends today";
  return {
    key: cycle.key,
    name: cycle.name,
    rangeLabel: `${utcDayLabel(start)} – ${utcDayLabel(end)}`,
    pct,
    statusLabel: `${pct}% complete · ${left}`,
  };
}
