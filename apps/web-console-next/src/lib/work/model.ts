// Pure presentation model for the work lens (unit-tested; no React).

import type { WorkRung, WorkTaskView } from "@saas/contracts/work";

export type BadgeVariant = "default" | "secondary" | "destructive" | "warning" | "success" | "outline";

const RUNG_LABELS: Record<WorkRung, string> = {
  draft: "Draft",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  released: "Released",
  canceled: "Canceled",
};

export function rungLabel(rung: WorkRung): string {
  return RUNG_LABELS[rung] ?? rung;
}

export function rungBadgeVariant(rung: WorkRung): BadgeVariant {
  switch (rung) {
    case "released":
      return "success";
    case "done":
      return "default";
    case "in_review":
    case "in_progress":
      return "warning";
    case "canceled":
      return "outline";
    default:
      return "secondary";
  }
}

/** Rung sort: most-delivered first within a spec, key as tiebreaker. */
const RUNG_SORT: Record<WorkRung, number> = {
  released: 0,
  done: 1,
  in_review: 2,
  in_progress: 3,
  ready: 4,
  draft: 5,
  canceled: 6,
};

export interface SpecGroup {
  spec: string | null;
  tasks: WorkTaskView[];
}

/** Groups tasks by spec (inbox last), tasks ordered by rung then key. */
export function groupTasksBySpec(tasks: WorkTaskView[]): SpecGroup[] {
  const bySpec = new Map<string | null, WorkTaskView[]>();
  for (const t of tasks) {
    const key = t.spec ?? null;
    const list = bySpec.get(key) ?? [];
    list.push(t);
    bySpec.set(key, list);
  }
  const groups: SpecGroup[] = [...bySpec.entries()]
    .map(([spec, list]) => ({
      spec,
      tasks: [...list].sort((a, b) => {
        const ra = RUNG_SORT[a.lifecycle.rung] ?? 99;
        const rb = RUNG_SORT[b.lifecycle.rung] ?? 99;
        if (ra !== rb) return ra - rb;
        return a.key < b.key ? -1 : 1;
      }),
    }))
    .sort((a, b) => {
      if (a.spec === null) return 1;
      if (b.spec === null) return -1;
      return a.spec < b.spec ? -1 : 1;
    });
  return groups;
}

/** Rungs a human may pin to (canceled is authored via cancel, not a pin). */
export const RUNGS_PINNABLE: WorkRung[] = ["draft", "ready", "in_progress", "in_review", "done", "released"];
