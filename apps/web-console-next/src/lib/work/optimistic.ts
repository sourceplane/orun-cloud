// The optimistic apply store (orun-work-v3 PM4; pure, unit-tested, no
// React). The Linear feel without the Linear lie: intent renders the moment
// you author it, but it renders AS AN OVERLAY over the fold's last answer —
// the server's verdict is still the only thing that commits. Confirmation
// rides the existing SSE tail: every mutation returns its event seq, and
// once the refetched summary's coordSeq reaches that seq the overlay entry
// has become server truth and is pruned. A 422 verdict removes the entry —
// the UI literally rolls back to what the fold last said, and the caller
// renders the verdict beside it. Rungs are untouchable here by construction:
// a patch can only carry intent fields.

import type { WorkPriority, WorkTaskView } from "@saas/contracts/work";

/** What an optimistic entry may change — intent fields ONLY. There is
 *  deliberately no rung/lifecycle member in this shape (WP-3). */
export interface TaskPatch {
  priority?: WorkPriority | undefined;
  estimate?: number | null | undefined; // null clears
  cycleKey?: string | null | undefined; // null clears
  addTag?: string | undefined;
  removeTag?: string | undefined;
}

export interface OptimisticEntry {
  id: number;
  key: string; // task key the patch applies to
  patch: TaskPatch;
  /** The committed event's seq once the mutation returns; undefined while
   *  the request is in flight. */
  seq?: number | undefined;
}

let nextId = 1;

/** Adds a pending entry; returns the new list and the entry id. */
export function begin(entries: OptimisticEntry[], key: string, patch: TaskPatch): { entries: OptimisticEntry[]; id: number } {
  const id = nextId++;
  return { entries: [...entries, { id, key, patch }], id };
}

/** Marks an entry committed at `seq` — it now waits for the summary's
 *  coordSeq to catch up, at which point prune() drops it. */
export function confirm(entries: OptimisticEntry[], id: number, seq: number): OptimisticEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, seq } : e));
}

/** Rolls an entry back (the mutator said no) — the overlay disappears and
 *  the fold's last answer shows through; the caller renders the verdict. */
export function reject(entries: OptimisticEntry[], id: number): OptimisticEntry[] {
  return entries.filter((e) => e.id !== id);
}

/** Drops entries the server state has caught up with (coordSeq >= their
 *  committed seq). In-flight entries (no seq yet) always survive. */
export function prune(entries: OptimisticEntry[], coordSeq: number): OptimisticEntry[] {
  return entries.filter((e) => e.seq === undefined || e.seq > coordSeq);
}

/** Applies one patch to one task view (pure). */
export function applyPatch(task: WorkTaskView, patch: TaskPatch): WorkTaskView {
  const next: WorkTaskView = { ...task };
  if (patch.priority !== undefined) {
    next.priority = patch.priority === "none" ? undefined : patch.priority;
  }
  if (patch.estimate !== undefined) {
    next.estimate = patch.estimate === null ? undefined : patch.estimate;
  }
  if (patch.cycleKey !== undefined) {
    next.cycleKey = patch.cycleKey === null ? undefined : patch.cycleKey;
  }
  if (patch.addTag !== undefined || patch.removeTag !== undefined) {
    const tags = new Set(task.tags ?? []);
    if (patch.addTag) tags.add(patch.addTag);
    if (patch.removeTag) tags.delete(patch.removeTag);
    next.tags = tags.size > 0 ? [...tags].sort() : undefined;
  }
  return next;
}

/** Overlays every entry (in insertion order) onto the task list. */
export function overlay(tasks: WorkTaskView[], entries: OptimisticEntry[]): WorkTaskView[] {
  if (entries.length === 0) return tasks;
  return tasks.map((task) => {
    let out = task;
    for (const e of entries) {
      if (e.key === task.key) out = applyPatch(out, e.patch);
    }
    return out;
  });
}
