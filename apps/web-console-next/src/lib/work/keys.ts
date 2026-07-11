// Pure keyboard grammar for the Work home (orun-work-v5 WV5;
// unit-tested, no React, no DOM types beyond duck-typing). The vocabulary
// of the keyboard is the vocabulary of the model: there is a key that
// pins and a key that creates — there is deliberately no key that
// "changes status" (design.md §4).

import type { WorkLens } from "@/lib/work/home";

export type WorkKeyAction =
  | { type: "lens"; lens: WorkLens }
  | { type: "focus-next" }
  | { type: "focus-prev" }
  | { type: "create" }
  | { type: "filter" }
  | { type: "display" };

interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** True when the event target owns the keyboard (inputs, editors, menus). */
export function isEditableTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Maps a raw key event to a Work-home action, or null. Modifier chords
 *  are left alone (⌘K and friends belong to the shell). */
export function workKeyAction(e: KeyEventLike, target?: TargetLike | null): WorkKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (isEditableTarget(target)) return null;
  switch (e.key) {
    case "1":
      return { type: "lens", lens: "initiatives" };
    case "2":
      return { type: "lens", lens: "epics" };
    case "3":
      return { type: "lens", lens: "tasks" };
    case "j":
    case "ArrowDown":
      return { type: "focus-next" };
    case "k":
    case "ArrowUp":
      return { type: "focus-prev" };
    case "c":
      return { type: "create" };
    case "f":
      return { type: "filter" };
    case "d":
      return { type: "display" };
    default:
      return null;
  }
}

/** The item kind `c` creates, by lens — creation follows attention. */
export function createKindForLens(lens: WorkLens): "task" | "spec" | "initiative" {
  return lens === "initiatives" ? "initiative" : lens === "epics" ? "spec" : "task";
}

/** Roving index over a row list; clamps at the edges (no wrap — Linear
 *  doesn't wrap either; the edge is information). -1 means nothing focused
 *  yet: next → first, prev → last. */
export function nextNavIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + delta));
}
