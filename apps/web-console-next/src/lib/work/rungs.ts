// Pure presentation model for the Work-plane rung glyphs and meters
// (orun-work-v5 WV0; unit-tested, no React). The glyph is a pure function
// of the fold output (V5-E): nothing here reads or writes lifecycle — it
// translates an observed rung into geometry.

import type { WorkRung } from "@saas/contracts/work";

/** The delivery ladder in fold order (canceled is not a ladder position). */
export const RUNG_LADDER: readonly WorkRung[] = [
  "draft",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "released",
];

export type RungGlyphKind =
  /** Dashed outline ring — intent exists, nothing observed yet. */
  | "dashed"
  /** Solid outline ring — observed ready, nothing in flight. */
  | "ring"
  /** Partial progress arc over a tinted track — in flight. */
  | "arc"
  /** Filled disc with a check — landed. */
  | "disc"
  /** Outline ring with a cross — authored cancel. */
  | "cross";

export interface RungGlyphSpec {
  kind: RungGlyphKind;
  /**
   * Ladder position encoded as an arc fraction. Ordinal, not task-internal
   * progress: In Progress is always the half ring, In Review always the
   * three-quarter ring (design.md §2 — instantly legible, never animated).
   */
  fraction: number;
}

const GLYPHS: Record<WorkRung, RungGlyphSpec> = {
  draft: { kind: "dashed", fraction: 0 },
  ready: { kind: "ring", fraction: 0 },
  in_progress: { kind: "arc", fraction: 0.5 },
  in_review: { kind: "arc", fraction: 0.75 },
  done: { kind: "disc", fraction: 1 },
  released: { kind: "disc", fraction: 1 },
  canceled: { kind: "cross", fraction: 0 },
};

export function rungGlyph(rung: WorkRung): RungGlyphSpec {
  return GLYPHS[rung] ?? GLYPHS.draft;
}

/** Circumference-based dasharray for the progress-arc glyph (r = 5.4 in a
 *  14×14 viewBox — the mock's exact geometry: ½ → "17 34", ¾ → "25.4 34"). */
export function arcDasharray(fraction: number, radius = 5.4): string {
  const circumference = 2 * Math.PI * radius;
  const on = Math.round(fraction * circumference * 10) / 10;
  return `${on} ${Math.round(circumference)}`;
}

/** The two meter segments every Work progress bar renders: landed green
 *  (done + released) and in-flight amber (in progress + in review). */
export interface MeterSegments {
  donePct: number;
  activePct: number;
  doneCount: number;
}

export function meterSegments(
  counts: Partial<Record<WorkRung, number>> | undefined,
  total: number,
): MeterSegments {
  if (!total || total <= 0) return { donePct: 0, activePct: 0, doneCount: 0 };
  const doneCount = (counts?.done ?? 0) + (counts?.released ?? 0);
  const activeCount = (counts?.in_progress ?? 0) + (counts?.in_review ?? 0);
  const donePct = Math.min(100, (doneCount / total) * 100);
  const activePct = Math.min(100 - donePct, (activeCount / total) * 100);
  return { donePct, activePct, doneCount };
}

/* ── The peek's rung ladder (orun-work-v5 WV3) ──────────────────────── */

export interface LadderLifecycle {
  rung: WorkRung;
  pinned?: { rung: WorkRung; by: { id: string } } | undefined;
}

/**
 * What clicking a ladder rung means (§3.6): clicking the pinned rung (or
 * the observed rung, which a pin can only restate) clears the pin;
 * clicking anything else mints one. The fold keeps rendering what it
 * observes either way — a pin is an opinion filed as an opinion.
 */
export function pinIntent(clicked: WorkRung, lifecycle: LadderLifecycle): { rung: WorkRung | null } | null {
  if (lifecycle.pinned) {
    if (clicked === lifecycle.pinned.rung || clicked === lifecycle.rung) return { rung: null };
    return { rung: clicked };
  }
  if (clicked === lifecycle.rung) return null; // nothing to assert
  return { rung: clicked };
}

/** The truth-source tag every peek renders beside the rung chip — never
 *  absent (WV-2): `observed` or `pinned by <actor>`. */
export function truthSourceTag(lifecycle: LadderLifecycle): string {
  return lifecycle.pinned ? `pinned by ${lifecycle.pinned.by.id}` : "observed";
}

export type MilestoneDiamondState = "complete" | "active" | "upcoming";

/** Milestone diamond state from its folded task counts (design.md §2). */
export function milestoneDiamondState(
  counts: Partial<Record<WorkRung, number>> | undefined,
  total: number,
): MilestoneDiamondState {
  if (!total) return "upcoming";
  const { doneCount, activePct } = meterSegments(counts, total);
  if (doneCount >= total) return "complete";
  if (doneCount > 0 || activePct > 0) return "active";
  return "upcoming";
}
