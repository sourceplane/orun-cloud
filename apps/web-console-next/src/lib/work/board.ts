// Pure helpers for the board surface (orun-work-v3 PM2; unit-tested, no
// React). Columns are rungs — the board renders the fold, it never stores a
// layout. Filters and grouping live here so the components stay thin.

import type { WorkPriority, WorkRung, WorkTaskView, WorkViewConfig } from "@saas/contracts/work";

/** Board columns in ladder order. Canceled is off-ladder: it renders as a
 *  collapsed tail column, never a drop target. */
export const BOARD_RUNGS: WorkRung[] = ["draft", "ready", "in_progress", "in_review", "done", "released"];

export const PRIORITY_ORDER: Record<WorkPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export const PRIORITY_OPTIONS: WorkPriority[] = ["urgent", "high", "medium", "low", "none"];

export interface BoardFilters {
  tags?: string[] | undefined;
  priority?: WorkPriority[] | undefined;
  rung?: WorkRung[] | undefined;
  spec?: string[] | undefined;
}

/** The rung a card renders under. A pinned card sits in its pinned column —
 *  the pin chip beside truth tells the reader the fold disagrees. */
export function boardRung(t: WorkTaskView): WorkRung {
  return t.lifecycle.pinned?.rung ?? t.lifecycle.rung;
}

/** True when every active filter admits the task (AND across dimensions,
 *  OR within one). Empty/absent dimensions admit everything. */
export function matchesFilters(t: WorkTaskView, f: BoardFilters): boolean {
  if (f.tags?.length && !f.tags.some((tag) => t.tags?.includes(tag))) return false;
  if (f.priority?.length && !f.priority.includes(t.priority ?? "none")) return false;
  if (f.rung?.length && !f.rung.includes(boardRung(t))) return false;
  if (f.spec?.length && !f.spec.includes(t.spec ?? "")) return false;
  return true;
}

export function applyFilters(tasks: WorkTaskView[], f: BoardFilters): WorkTaskView[] {
  return tasks.filter((t) => matchesFilters(t, f));
}

/** Groups tasks into rung columns (ladder order), each column sorted by
 *  priority then key — a deterministic render of derived truth. */
export function boardColumns(tasks: WorkTaskView[]): Array<{ rung: WorkRung; tasks: WorkTaskView[] }> {
  const byRung = new Map<WorkRung, WorkTaskView[]>();
  for (const t of tasks) {
    const rung = boardRung(t);
    const list = byRung.get(rung) ?? [];
    list.push(t);
    byRung.set(rung, list);
  }
  const sortColumn = (list: WorkTaskView[]) =>
    [...list].sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority ?? "none"];
      const pb = PRIORITY_ORDER[b.priority ?? "none"];
      if (pa !== pb) return pa - pb;
      return a.key < b.key ? -1 : 1;
    });
  return BOARD_RUNGS.map((rung) => ({ rung, tasks: sortColumn(byRung.get(rung) ?? []) }));
}

/** All labels in use, sorted — the filter bar's chip row. */
export function allTags(tasks: WorkTaskView[]): string[] {
  const tags = new Set<string>();
  for (const t of tasks) for (const tag of t.tags ?? []) tags.add(tag);
  return [...tags].sort();
}

/** Toggle helper for multi-select filter chips. */
export function toggled<T>(list: T[] | undefined, value: T): T[] | undefined {
  const current = list ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return next.length > 0 ? next : undefined;
}

export function hasActiveFilters(f: BoardFilters): boolean {
  return Boolean(f.tags?.length || f.priority?.length || f.rung?.length || f.spec?.length);
}

/** Serializes the current surface into a saveable view config. */
export function toViewConfig(layout: "board" | "list", filters: BoardFilters): WorkViewConfig {
  const config: WorkViewConfig = { layout };
  if (hasActiveFilters(filters)) config.filters = filters;
  return config;
}

/** The honest-drag classifier (design's spine): a drop on another column is
 *  a PIN (attributed override beside truth), a drop on the same column is
 *  an ORDER (pure backlog intent), and dropping where the fold already is
 *  clears any pin (facts caught up). */
export function dropIntent(
  task: WorkTaskView,
  onto: WorkRung,
): { kind: "pin"; rung: WorkRung } | { kind: "unpin" } | { kind: "order" } {
  if (onto === boardRung(task)) return { kind: "order" };
  if (onto === task.lifecycle.rung) return { kind: "unpin" }; // facts already there — dropping "back" clears the pin
  return { kind: "pin", rung: onto };
}
