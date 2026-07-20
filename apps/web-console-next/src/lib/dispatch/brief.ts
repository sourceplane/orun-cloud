// The standing brief (saas-dispatch DX4) — pull-rendered, exactly as the
// epic's risk register demands: "the brief is a SURFACE (pull-rendered from
// the Situation), not a second doorbell." AL8 stays the only push channel.
//
// Design note (recorded): the model-driven scheduled brief (an attributed
// agent turn composed by the model overnight) stays deferred with AN6's
// proactive tail — a scheduled turn has no owner credential to fold or call
// the model with (lock 4/6), so it waits on the agent-principal credential.
// This brief needs neither: it composes from the Situation the viewer just
// folded with their own bearer, on arrival.

import type { Situation } from "@saas/contracts/dispatch";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const VISIT_PREFIX = "sp.dispatch.visit.";
const MUTE_PREFIX = "sp.dispatch.brief-muted.";

export function readLastVisit(store: StorageLike | null, orgSlug: string): string | null {
  try {
    return store?.getItem(`${VISIT_PREFIX}${orgSlug}`) ?? null;
  } catch {
    return null;
  }
}

export function writeLastVisit(store: StorageLike | null, orgSlug: string, iso: string): void {
  try {
    store?.setItem(`${VISIT_PREFIX}${orgSlug}`, iso);
  } catch {
    // Preference-only; a denied write degrades to a chattier brief.
  }
}

export function readBriefMuted(store: StorageLike | null, orgSlug: string): boolean {
  try {
    return store?.getItem(`${MUTE_PREFIX}${orgSlug}`) === "1";
  } catch {
    return false;
  }
}

export function writeBriefMuted(store: StorageLike | null, orgSlug: string, muted: boolean): void {
  try {
    store?.setItem(`${MUTE_PREFIX}${orgSlug}`, muted ? "1" : "0");
  } catch {
    // Preference-only.
  }
}

export interface Brief {
  lines: string[];
  /** The needs-you numeral (the ambient badge shows the same number). */
  pending: number;
}

/**
 * composeBrief — the digest, from the viewer's own authorized fold. Null when
 * there is nothing worth saying (all quiet) — an empty brief never renders.
 * Every line derives from Situation facts; nothing here asserts progress.
 */
export function composeBrief(situation: Situation): Brief | null {
  const lines: string[] = [];
  if (situation.ready.length > 0) {
    lines.push(`${situation.ready.length} task${situation.ready.length === 1 ? "" : "s"} Ready to dispatch`);
  }
  if (situation.inFlight.length > 0) {
    lines.push(`${situation.inFlight.length} session${situation.inFlight.length === 1 ? "" : "s"} in flight`);
  }
  if (situation.waitingOnMe.length > 0) {
    lines.push(
      `${situation.waitingOnMe.length} item${situation.waitingOnMe.length === 1 ? "" : "s"} waiting on you`,
    );
  }
  const b = situation.budget;
  if (b.workspaceMaxTokens !== null && b.workspaceMaxTokens > 0) {
    const frac = b.liveTokens / b.workspaceMaxTokens;
    if (frac >= b.softMark) {
      lines.push(`budget at ${Math.round(frac * 100)}% of the workspace ceiling`);
    }
  }
  if (lines.length === 0) return null;
  return { lines, pending: situation.waitingOnMe.length };
}

/** The ambient badge numeral: the needs-you count from the viewer-agnostic
 * shell counts (the DX1 report payload). Zero renders nothing. */
export function pendingBadgeCount(counts: Record<string, number> | undefined): number {
  const n = counts?.waitingOnMe ?? 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
