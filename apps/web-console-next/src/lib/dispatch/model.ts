// Pure presentation model for the Dispatch surface (saas-dispatch DX2).
// Dependency-free so jest drives it directly (the agents-model discipline).
//
// The two-plane rule (epic decision D5, table-tested): a session card renders
// INFRASTRUCTURE facts and a work card renders FOLD facts — the model has no
// function that merges them into one "status", and the guard test pins that.

import type {
  Situation,
  SituationAttentionItem,
  SituationReadyItem,
  SituationSessionItem,
} from "@saas/contracts/dispatch";
import type { Tone } from "@/components/ui/northwind";

// ── Shell reporting (the DX1 rendezvous) ────────────────────────────────────

/** The viewer-agnostic counts a head reports beside its cursor — aggregate
 * numerals only, never item content (the DispatchIndex holds no authorized
 * content, DD7). */
export function situationCounts(s: Situation): Record<string, number> {
  return {
    ready: s.ready.length,
    inFlight: s.inFlight.length,
    waitingOnMe: s.waitingOnMe.length,
    running: s.counts.running ?? 0,
  };
}

// ── Budget ──────────────────────────────────────────────────────────────────

export interface BudgetView {
  hasCeiling: boolean;
  /** 0–100, clamped; 0 when no ceiling is set. */
  pct: number;
  tone: Tone;
  label: string;
}

export function budgetView(b: Situation["budget"]): BudgetView {
  if (b.workspaceMaxTokens === null || b.workspaceMaxTokens <= 0) {
    return { hasCeiling: false, pct: 0, tone: "neutral", label: "No workspace ceiling set" };
  }
  const raw = (b.liveTokens / b.workspaceMaxTokens) * 100;
  const pct = Math.max(0, Math.min(100, Math.round(raw)));
  const tone: Tone = raw >= 100 ? "error" : raw >= b.softMark * 100 ? "warning" : "success";
  return {
    hasCeiling: true,
    pct,
    tone,
    label: `${b.liveTokens.toLocaleString()} / ${b.workspaceMaxTokens.toLocaleString()} tokens live`,
  };
}

// ── Links (URL-scope discipline: every card lands somewhere real) ──────────

export function sessionHref(orgSlug: string, sessionId: string): string {
  return `/orgs/${orgSlug}/agents/${sessionId}`;
}

export function workItemHref(orgSlug: string, key: string): string {
  return `/orgs/${orgSlug}/work?item=${encodeURIComponent(key)}`;
}

/** Where an attention item lands: its session page (verdicts are ANSWERED
 * there, never here — AN lock 5), or the fleet home for routine items. */
export function attentionHref(orgSlug: string, item: SituationAttentionItem): string {
  if (item.sessionId) return sessionHref(orgSlug, item.sessionId);
  return `/orgs/${orgSlug}/agents`;
}

// ── Cards (plane-separated by construction) ────────────────────────────────

/** The work plane's card: fold facts only — no session state field exists
 * on this shape, so a UI cannot merge planes without the type failing. */
export interface ReadyCardView {
  plane: "work";
  key: string;
  title: string;
  evidenceLine: string | null;
  href: (orgSlug: string) => string;
}

export function readyCard(item: SituationReadyItem): ReadyCardView {
  return {
    plane: "work",
    key: item.key,
    title: item.title,
    evidenceLine: item.evidence && item.evidence.length > 0 ? item.evidence.join(" · ") : null,
    href: (orgSlug) => workItemHref(orgSlug, item.key),
  };
}

/** The session plane's card: infrastructure facts only — the work pointer is
 * a LINK (taskKey), never a rung. */
export interface SessionCardView {
  plane: "session";
  id: string;
  state: string;
  runKind: string;
  taskKey: string | null;
  tokensUsed: number;
  isChild: boolean;
  href: (orgSlug: string) => string;
}

export function sessionCard(item: SituationSessionItem): SessionCardView {
  return {
    plane: "session",
    id: item.id,
    state: item.state,
    runKind: item.runKind,
    taskKey: item.taskKey ?? null,
    tokensUsed: item.tokensUsed ?? 0,
    isChild: (item.depth ?? 0) > 0,
    href: (orgSlug) => sessionHref(orgSlug, item.id),
  };
}

export interface AttentionCardView {
  kind: string;
  reason: string;
  /** True when a human verdict is the only way to clear it (lock 5: the card
   * SURFACES, the session page ANSWERS). */
  humanGated: boolean;
  href: (orgSlug: string) => string;
}

export function attentionCard(item: SituationAttentionItem): AttentionCardView {
  return {
    kind: item.kind,
    reason: item.reason,
    humanGated: item.kind === "verdict",
    href: (orgSlug) => attentionHref(orgSlug, item),
  };
}

// ── Degradation ────────────────────────────────────────────────────────────

/** Sections that failed to fold, for the honest "source unreachable" chip. */
export function unavailableSections(s: Situation): string[] {
  const out: string[] = [];
  for (const [name, meta] of Object.entries(s.sections)) {
    if (meta?.unavailable) out.push(name);
  }
  return out;
}
