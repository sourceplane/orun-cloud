// Budget arithmetic (saas-agents-fleet AF8, design §7) — pure folds over
// budget rows + session spend. Ceilings, not advisories: `checkDoor` is the
// spawn-time refusal, `envelopeCrossings` is the ingest-time interrupt
// decision, and `budgetMarks` feeds the attention plane's 80% items. All
// row arithmetic — usage lives on the session rows (tokens_used), so
// nothing here round-trips a meter.

import type { AgentSession, Budget } from "@saas/db/agents";
import { BUDGET_SOFT_MARK } from "@saas/contracts/agents";

/** The workspace ceiling covers a rolling window of spend. */
export const WORKSPACE_BUDGET_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface Ceilings {
  workspace?: number;
  tree?: number;
  session?: number;
  /** routine public id → per-firing ceiling. */
  routine: Map<string, number>;
}

export function resolveCeilings(budgets: Budget[]): Ceilings {
  const out: Ceilings = { routine: new Map() };
  for (const b of budgets) {
    if (b.grain === "workspace") out.workspace = b.maxTokens;
    else if (b.grain === "tree") out.tree = b.maxTokens;
    else if (b.grain === "session") out.session = b.maxTokens;
    else if (b.grain === "routine" && b.ref) out.routine.set(b.ref, b.maxTokens);
  }
  return out;
}

/** Rolling-window workspace spend: sessions created inside the window. */
export function workspaceUsage(sessions: AgentSession[], now: Date): number {
  const floor = now.getTime() - WORKSPACE_BUDGET_WINDOW_MS;
  let total = 0;
  for (const s of sessions) {
    if (Date.parse(s.createdAt) >= floor) total += s.tokensUsed;
  }
  return total;
}

/** A delegation tree's spend: every node under the root, lifetime. */
export function treeUsage(sessions: AgentSession[], rootSessionId: string): number {
  let total = 0;
  for (const s of sessions) {
    if (s.rootSessionId === rootSessionId) total += s.tokensUsed;
  }
  return total;
}

export interface DoorRefusal {
  code: "budget_exhausted";
  message: string;
}

/**
 * checkDoor — may this spawn start? Refuses only on an ALREADY-exhausted
 * envelope (loud at the gate); a spawn under a nearly-spent ceiling is
 * allowed and will interrupt gracefully when it crosses (design §7).
 */
export function checkDoor(
  budgets: Budget[],
  sessions: AgentSession[],
  opts: { rootSessionId?: string; routineId?: string },
  now: Date,
): DoorRefusal | null {
  const ceilings = resolveCeilings(budgets);
  if (ceilings.workspace !== undefined) {
    const used = workspaceUsage(sessions, now);
    if (used >= ceilings.workspace) {
      return {
        code: "budget_exhausted",
        message: `Workspace budget exhausted (${used}/${ceilings.workspace} tokens in the last 30d)`,
      };
    }
  }
  if (opts.rootSessionId && ceilings.tree !== undefined) {
    const used = treeUsage(sessions, opts.rootSessionId);
    if (used >= ceilings.tree) {
      return {
        code: "budget_exhausted",
        message: `Tree budget exhausted (${used}/${ceilings.tree} tokens on this tree)`,
      };
    }
  }
  return null;
}

export interface Crossing {
  /** The tightest ceiling crossed. */
  grain: "session" | "tree" | "routine";
  limit: number;
  used: number;
}

/**
 * envelopeCrossings — did THIS session's spend cross its applicable ceiling
 * with this delta? Fires exactly on the crossing (prev < limit ≤ next), so
 * the interrupt enqueues once, not on every later sample.
 */
export function envelopeCrossings(
  budgets: Budget[],
  sessions: AgentSession[],
  session: AgentSession,
  prevTokens: number,
): Crossing | null {
  const ceilings = resolveCeilings(budgets);
  // Tightest first: the per-firing routine ceiling, then session, then tree.
  if (session.routineId !== undefined) {
    const limit = ceilings.routine.get(session.routineId);
    if (limit !== undefined && prevTokens < limit && session.tokensUsed >= limit) {
      return { grain: "routine", limit, used: session.tokensUsed };
    }
  }
  if (ceilings.session !== undefined && prevTokens < ceilings.session && session.tokensUsed >= ceilings.session) {
    return { grain: "session", limit: ceilings.session, used: session.tokensUsed };
  }
  if (ceilings.tree !== undefined) {
    const used = treeUsage(sessions, session.rootSessionId);
    const prevTree = used - (session.tokensUsed - prevTokens);
    if (prevTree < ceilings.tree && used >= ceilings.tree) {
      return { grain: "tree", limit: ceilings.tree, used };
    }
  }
  return null;
}

export interface BudgetMark {
  grain: "workspace" | "tree" | "session";
  /** tree/session marks carry the session or root id. */
  ref?: string;
  used: number;
  limit: number;
}

/** budgetMarks — every envelope at or past the soft mark, for the attention
 * fold. Live sessions/trees only (a finished overspend is history). */
export function budgetMarks(budgets: Budget[], sessions: AgentSession[], now: Date): BudgetMark[] {
  const ceilings = resolveCeilings(budgets);
  const marks: BudgetMark[] = [];
  const live = (s: AgentSession) =>
    !["completed", "failed", "canceled", "expired"].includes(s.state);

  if (ceilings.workspace !== undefined) {
    const used = workspaceUsage(sessions, now);
    if (used >= ceilings.workspace * BUDGET_SOFT_MARK) {
      marks.push({ grain: "workspace", used, limit: ceilings.workspace });
    }
  }
  if (ceilings.tree !== undefined) {
    const roots = new Set(sessions.filter((s) => live(s)).map((s) => s.rootSessionId));
    for (const root of roots) {
      const used = treeUsage(sessions, root);
      if (used >= ceilings.tree * BUDGET_SOFT_MARK) {
        marks.push({ grain: "tree", ref: root, used, limit: ceilings.tree });
      }
    }
  }
  if (ceilings.session !== undefined) {
    for (const s of sessions) {
      if (live(s) && s.tokensUsed >= ceilings.session * BUDGET_SOFT_MARK) {
        marks.push({ grain: "session", ref: s.publicId, used: s.tokensUsed, limit: ceilings.session });
      }
    }
  }
  return marks;
}
