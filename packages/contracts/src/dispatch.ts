// Dispatch contracts — the Situation read-model (saas-dispatch DX0).
// Owner: api-edge (the situation facade); consumed by the console + SDK.
//
// The Situation is a per-viewer FOLD, never a table (epic decision DD2): it
// composes reads that already exist — the work fold (state-worker), the
// session list + attention fold + budgets (agents-worker) — under the
// viewer's own credential. Nothing here writes; nothing here stores; there
// is deliberately no "status" field an agent could author. Section sources
// can degrade independently (`unavailable`), so a partial Situation renders
// honestly instead of failing the page.
//
// Spec: specs/epics/saas-dispatch/ (design §1).

// ── Versioning ──────────────────────────────────────────────

/** Highest dispatch-plane contract major this server implements. */
export const DISPATCH_CONTRACT_VERSION = 1 as const;

// ── Plane tags ──────────────────────────────────────────────
// Every item names the plane it comes from so the UI can honor D5 (session
// infrastructure state and work rungs render side by side, never merged).

export const SITUATION_PLANES = ["work", "session", "governance"] as const;
export type SituationPlane = (typeof SITUATION_PLANES)[number];

// ── Sections ────────────────────────────────────────────────

/** One dispatchable work item: the fold says Ready and nobody holds it.
 * Evidence is the fold's own arithmetic ("contract complete; deps closed") —
 * the UI reasons over evidence, never a bare enum. */
export interface SituationReadyItem {
  plane: "work";
  key: string;
  title: string;
  spec?: string;
  /** The fold's evidence lines for the current rung, verbatim. */
  evidence?: string[];
  priority?: string;
  labels?: Record<string, string>;
}

/** One live hosted session — an infrastructure fact (AG7 projection). */
export interface SituationSessionItem {
  plane: "session";
  /** Public session id, `as_…`. */
  id: string;
  /** Control-plane infrastructure state (never a work rung). */
  state: string;
  runKind: string;
  profileId: string;
  taskKey?: string;
  workRef?: string;
  spawnedBy: string;
  startedAt?: string;
  /** When the session row was created — the honest age of a `requested`
   * session that never started (saas-dispatch-delight DD4). */
  createdAt?: string;
  /** Accumulated relayed spend (AF8 cost samples). */
  tokensUsed?: number;
  /** Delegation-tree placement (AF4). */
  parentSessionId?: string;
  depth?: number;
}

/** One needs-you item — the AF5 attention fold, passed through with its
 * provenance intact (kind, producing fact, the answerable request). */
export interface SituationAttentionItem {
  plane: "session" | "governance";
  kind: string;
  reason: string;
  at: string;
  sessionId?: string;
  routineId?: string;
  taskKey?: string;
  workRef?: string;
  /** verdict items: the pending approval, answered on the session page. */
  request?: { requestId: string; tool: string };
}

/** The governance headroom for the workspace's session tree (AF8/AF9).
 * `liveTokens` is the summed relayed spend of currently-live sessions — a
 * live-view figure, NOT the billing meter (metering owns billing truth). */
export interface SituationBudget {
  plane: "governance";
  /** The workspace-grain ceiling, when one is set. */
  workspaceMaxTokens: number | null;
  /** Summed `tokensUsed` across live sessions (the in-flight view). */
  liveTokens: number;
  /** The soft mark fraction (attention fires past it). */
  softMark: number;
}

// ── The fold ────────────────────────────────────────────────

/** Which upstream fed each section, with per-section degradation: a section
 * whose source failed reports `unavailable: true` and an empty list rather
 * than failing the whole Situation (partial truth over a blank page). */
export interface SituationSectionMeta {
  unavailable?: boolean;
}

export interface Situation {
  /** Dispatchable now: fold rung `ready` ∧ unassigned. */
  ready: SituationReadyItem[];
  /** Live sessions: requested | provisioning | running | awaiting_approval. */
  inFlight: SituationSessionItem[];
  /** The needs-you queue (AF5), ranked upstream. */
  waitingOnMe: SituationAttentionItem[];
  /** Per-kind attention counts (every kind present, zeros included) plus the
   * running-session stat, straight from the attention fold. */
  counts: Record<string, number>;
  budget: SituationBudget;
  /** Fold watermark: the work plane's `w<coordSeq>.<obsSeq>` — a real
   * sequence cursor, monotone per workspace, for incremental refresh (DX1). */
  cursor: string;
  /** Per-section degradation flags. */
  sections: {
    ready: SituationSectionMeta;
    inFlight: SituationSectionMeta;
    waitingOnMe: SituationSectionMeta;
    budget: SituationSectionMeta;
  };
}

// ── Error codes ─────────────────────────────────────────────

export const DISPATCH_ERROR_CODES = {
  /** Every section source failed — nothing truthful to render. */
  situationUnavailable: "situation_unavailable",
} as const;
export type DispatchErrorCode =
  (typeof DISPATCH_ERROR_CODES)[keyof typeof DISPATCH_ERROR_CODES];

// ── Live session states (mirrors the agents plane's live set) ───────────────

export const SITUATION_LIVE_SESSION_STATES = [
  "requested",
  "provisioning",
  "running",
  "awaiting_approval",
] as const;

export function isLiveSessionState(s: string): boolean {
  return (SITUATION_LIVE_SESSION_STATES as readonly string[]).includes(s);
}
