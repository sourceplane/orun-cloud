// Agents contracts — Orun Cloud's agent-session control plane.
// Owner: agents-worker (apps/agents-worker).
//
// The runtime that actually runs an agent is the orun binary
// (orun/specs/orun-agents/); this plane HOSTS it: it provisions a sandbox,
// mints a session-scoped credential, relays the session's event stream, and
// dispatches. These shapes are what crosses the public API boundary and what
// the console + SDK consume. No secret values, no model keys, no raw
// transcript bytes here — bulk transcript lives in R2 and the sealed
// AgentSessionSnapshot lives in orun's object graph; these are safe
// projections.
//
// Spec: specs/epics/saas-agents/ (AG5–AG11), paired runtime
// orun/specs/orun-agents/.

// ── Versioning ──────────────────────────────────────────────

/** Highest agents-plane contract major this server implements. */
export const AGENTS_CONTRACT_VERSION = 1 as const;

// ── Error codes ─────────────────────────────────────────────
// Layered on the platform envelope (`{ error: { code, message, details?,
// requestId } }`) so every consumer names them identically.

export const AGENTS_ERROR_CODES = {
  /** feature.agents entitlement not granted for the workspace. */
  agentsNotEntitled: "agents_not_entitled",
  /** Per-workspace concurrent-session quota reached. */
  sessionQuotaExceeded: "session_quota_exceeded",
  /** The named agent profile does not exist in the workspace. */
  profileNotFound: "agent_profile_not_found",
  /** The session id does not exist or is not visible to the caller. */
  sessionNotFound: "agent_session_not_found",
  /** A steer/kill was sent to a session not in a steerable state. */
  sessionNotLive: "agent_session_not_live",
  /** The sandbox provider failed to provision/resume. */
  sandboxUnavailable: "sandbox_unavailable",
  /** DX7: a managed-interface profile needs a definition-time tools
   * allowlist (no verdict channel exists to ask mid-run). */
  interfaceRequiresAsk: "interface_requires_ask",
} as const;

export type AgentsErrorCode =
  (typeof AGENTS_ERROR_CODES)[keyof typeof AGENTS_ERROR_CODES];

// ── Vocabularies ────────────────────────────────────────────

/**
 * Control-plane session states — INFRASTRUCTURE facts ("is there a sandbox and
 * is it healthy"), categorically distinct from the work plane's derived
 * lifecycle rungs. A session can be `completed` while its task sits In Review;
 * the console renders both, never merged.
 */
export const AGENT_SESSION_STATES = [
  "requested",
  "provisioning",
  "running",
  "awaiting_approval",
  "suspended",
  "completing",
  "completed",
  "failed",
  "canceled",
  "expired",
] as const;
export type AgentSessionState = (typeof AGENT_SESSION_STATES)[number];

/** Terminal states — no further transitions, sandbox destroyed. */
export const AGENT_SESSION_TERMINAL_STATES = [
  "completed",
  "failed",
  "canceled",
  "expired",
] as const;

export function isTerminalSessionState(s: AgentSessionState): boolean {
  return (AGENT_SESSION_TERMINAL_STATES as readonly string[]).includes(s);
}

/**
 * Delegation interfaces (saas-dispatch DX7): HOW a profile's runs execute.
 * `orun-sandbox` — `orun agent serve` in a Daytona box against a sealed
 * brief (a **Sealed run**: content-addressed input, replayable snapshot,
 * mid-run ask-gated approvals). `anthropic-managed` — a Claude Managed
 * Agents cloud session spawned via API (a **Managed run**: seconds to first
 * token, definition-time tool narrowing ONLY — no verdict channel exists,
 * so `awaiting_approval` is unreachable on this interface by construction).
 * One dispatch door governs both (DD9); the tier renders, never averaged
 * (DD10).
 */
export const DELEGATION_INTERFACES = ["orun-sandbox", "anthropic-managed"] as const;
export type DelegationInterface = (typeof DELEGATION_INTERFACES)[number];

/** Run kinds — mirrors the orun runtime's nodes.RunKind*. */
export const AGENT_RUN_KINDS = [
  "design",
  "implementation",
  "interactive",
  "fix",
] as const;
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];

/**
 * Origin — the taint (saas-agent-supervision SV0). WHO set an implementer
 * running, recorded ONCE at the AG9 dispatch door from the authenticated
 * caller's context (never from a client-supplied field — a body cannot claim
 * a provenance it does not hold). Immutable: a re-parented tree keeps each
 * node's original origin; the AF4 tree columns carry structure, origin carries
 * provenance. Rendered as one chip vocabulary everywhere and, on the
 * Implementers surface, a filter facet.
 */
export const AGENT_ORIGIN_KINDS = [
  /** The Workspace Agent's `session_spawn` (human-prompted OR supervisor turn); ref = the thread `ch_…`. */
  "dispatch",
  /** Spawn from a Work surface (task "Ship it", design-doc implement, epic implementer); ref = workRef/taskKey. */
  "work",
  /** An AF6 routine firing; ref = the routine's public id (`rt_…`). */
  "routine",
  /** A parent session's spawn door (AF4 delegation); ref = the parent `as_…`. */
  "session",
  /** Direct spawn from the fleet/profile UI or CLI; no ref. */
  "human",
] as const;
export type AgentOriginKind = (typeof AGENT_ORIGIN_KINDS)[number];

/**
 * The immutable provenance stamped on every session row. `ref` points at the
 * origin (thread, work item, routine, parent session); `label` is a
 * human-friendly rendering ("Design WD-12", "Epic ORN-142") captured at the
 * door for chips that must read without a second fetch. `backfilled` marks a
 * row whose origin was INFERRED by the SV0 migration rather than recorded by
 * the door, so nobody mistakes inference for door-recorded truth.
 */
export interface AgentOrigin {
  kind: AgentOriginKind;
  ref?: string;
  label?: string;
  backfilled?: boolean;
}

/**
 * Autonomy ladder (AG9). Per-spec (fallback per-workspace) policy — agent-plane
 * configuration, never work truth.
 */
export const AGENT_AUTONOMY_LEVELS = [
  "manual",
  "assist",
  "auto-dispatch",
  "full",
] as const;
export type AgentAutonomyLevel = (typeof AGENT_AUTONOMY_LEVELS)[number];

// ── Wire shapes ─────────────────────────────────────────────

/**
 * An agent profile: a workspace's binding of an orun agent *type* to a
 * membership service principal, with a mandatory responsible owner. The
 * capability contract (tools/mayAffect/secrets) may only NARROW the sealed
 * agent-type ceiling — never widen it.
 */
export interface AgentProfile {
  /** Public id, `agp_…`. */
  id: string;
  /** Workspace-unique name, e.g. "impl-default". */
  name: string;
  /** The service principal this profile acts as (`sp_…`). */
  principalId: string;
  /** Mandatory responsible owner (a membership subject: `usr_`/`team_`). */
  owner: string;
  /** The orun agent-type this profile binds (its sealed object id or name). */
  agentType: string;
  harness: string;
  model: string;
  /** How this profile's runs execute (DX7). Default: orun-sandbox. */
  interface: DelegationInterface;
  autonomyDefault: AgentAutonomyLevel;
  /** The address of the last autonomy movement (AF7): {direction, from, to,
   * by, at, record?|trigger?}. Absent = never moved. */
  autonomyEvidence?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Create body for POST /agents/profiles. */
export interface CreateAgentProfileRequest {
  name: string;
  principalId: string;
  owner: string;
  agentType: string;
  harness: string;
  model: string;
  /** DX7: the delegation interface; omitted = orun-sandbox. */
  interface?: DelegationInterface;
  autonomyDefault?: AgentAutonomyLevel;
  capability?: Record<string, unknown>;
}

/** Create body for POST /agents/sessions (spawnedBy comes from the actor). */
export interface CreateAgentSessionRequest {
  profileId: string;
  runKind: AgentRunKind;
  workRef?: string;
  taskKey?: string;
}

/**
 * A hosted session — one run of the orun runtime inside a sandbox. The system
 * of record for what the agent DID is the sealed AgentSessionSnapshot in
 * orun's object graph; this is the control-plane projection the console reads.
 */
export interface AgentSession {
  /** Public id, `as_…` (matches the orun-side sessionId). */
  id: string;
  profileId: string;
  runKind: AgentRunKind;
  state: AgentSessionState;
  /** work://… pointer to the task/spec this run targets, when bound. */
  workRef?: string;
  /** The task key carried on the branch, e.g. "ORN-142". */
  taskKey?: string;
  /** The PR the run opened, when it has. */
  prUrl?: string;
  /** The sealed AgentSessionSnapshot id, once the run seals (terminal). */
  snapshotId?: string;
  /** Who spawned it (a membership subject). */
  spawnedBy: string;
  /** Why a failed session failed (redacted: never a provider body). */
  failureReason?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  /** Delegation tree (saas-agents-fleet AF4): present on a child; a root is
   * its own rootSessionId at depth 0. Public session ids throughout. */
  parentSessionId?: string;
  rootSessionId?: string;
  depth?: number;
  /** Routine provenance (AF6): the firing routine's public id (`rt_…`). */
  routineId?: string;
  /** Accumulated relayed spend (AF8): summed cost samples. */
  tokensUsed?: number;
  /** Immutable provenance stamped at the door (SV0). Recorded on every row
   * (default `{kind:"human"}`); backfilled rows carry `backfilled: true`. */
  origin: AgentOrigin;
}

/**
 * One relayed session-log entry the console renders. It mirrors the orun
 * runtime's closed event vocabulary; there is deliberately no status/lifecycle
 * kind, so "agent asserts progress" is unrepresentable here too.
 */
export const AGENT_SESSION_EVENT_KINDS = [
  "state_changed",
  "harness_event",
  "message_user",
  "message_agent",
  "tool_call",
  "tool_result",
  "approval_requested",
  "approval_resolved",
  "artifact_produced",
  "cost_sample",
  "error",
  // Delegation (AF4): the parent's sealed story of its children — emitted by
  // the runtime, relayed like everything else. Still no status/lifecycle kind.
  "child_spawned",
  "child_completed",
  "child_failed",
] as const;
export type AgentSessionEventKind =
  (typeof AGENT_SESSION_EVENT_KINDS)[number];

export interface AgentSessionEventWire {
  seq: number;
  kind: AgentSessionEventKind;
  at: string;
  /** Small structured payload; bulk content is an R2 ref, not inlined. */
  payload?: Record<string, unknown>;
  ref?: string;
}

// ── The SandboxProvider seam (AG5) ──────────────────────────
// External compute behind a narrow interface — Daytona first, a local-docker
// dev adapter for CI, anything with create/exec/snapshot/destroy later. These
// are TYPES only (contracts stays dependency-free); the adapters live in
// apps/agents-worker/src/providers/.

export interface SandboxSpec {
  /** Snapshot/image to boot from, when the connection pins one. Omitted =
   * the provider account's default image (the bootstrap installs orun). */
  baseSnapshot?: string;
  /** Non-secret environment for the sandbox. Secrets never appear here. */
  env?: Record<string, string>;
  /** Hard TTL after which the control plane reclaims the sandbox. */
  ttlSeconds: number;
  /**
   * Egress allowlist (hostnames the sandbox may reach). Default-deny: the
   * platform API + MCP, the git host, the model provider, package registries.
   */
  egressAllow: string[];
}

export interface SandboxRef {
  /** Provider-scoped handle (opaque to the control plane). */
  id: string;
  provider: string;
}

export interface SandboxHealth {
  healthy: boolean;
  detail?: string;
}

/**
 * The provider seam. Implemented by the Daytona adapter and the local-docker
 * dev adapter; the control plane depends only on this. No inbound network path
 * to sandboxes — the in-sandbox supervisor dials out — so an adapter never
 * needs to reach in.
 */
export interface SandboxProvider {
  readonly id: string;
  create(spec: SandboxSpec): Promise<SandboxRef>;
  /** Start the session bootstrap (or any command) in the sandbox. */
  exec(ref: SandboxRef, cmd: string[], opts?: { env?: Record<string, string> }): Promise<void>;
  /** Run a short command SYNCHRONOUSLY and return its output — used to probe
   * the resolved orun version into the provision trace. Optional: adapters that
   * cannot capture output (or dev fixtures) omit it and the probe is skipped. */
  execCapture?(ref: SandboxRef, cmd: string[]): Promise<{ stdout: string; exitCode: number }>;
  snapshot(ref: SandboxRef): Promise<string>;
  resume(snapshotId: string): Promise<SandboxRef>;
  destroy(ref: SandboxRef): Promise<void>;
  health(ref: SandboxRef): Promise<SandboxHealth>;
}

// ── The delegation plane (saas-agents-fleet AF4) ────────────
// Sessions spawn sessions through the cloud door; the tree only narrows.
// The intersection here is deliberately set math over sealed contracts —
// never policy evaluation (locked decision 1: the cloud gains a door, not
// an orchestration engine).

export const DELEGATION_ERROR_CODES = {
  /** The caller's session may not spawn (profile/type lacks delegation). */
  spawnNotAllowed: "agent_spawn_not_allowed",
  /** The parent is not in a spawnable (live) state. */
  parentNotLive: "agent_parent_not_live",
  /** depth would exceed the tree ceiling. */
  treeDepthExceeded: "agent_tree_depth_exceeded",
  /** live children per parent / live nodes per tree at cap. */
  treeWidthExceeded: "agent_tree_width_exceeded",
} as const;
export type DelegationErrorCode =
  (typeof DELEGATION_ERROR_CODES)[keyof typeof DELEGATION_ERROR_CODES];

/** Hard tree caps (design §3.1; workspace-configurable later — F-Q2). */
export const TREE_LIMITS = {
  /** A root is depth 0; children depth 1; sub-orchestrators depth 2. */
  maxDepth: 2,
  maxLiveChildrenPerParent: 5,
  maxLiveNodesPerTree: 10,
} as const;

/**
 * A capability ceiling — the narrowing-only contract surface the spawn door
 * intersects. An ABSENT key means "unrestricted at this level" (the sealed
 * agent-type ceiling still applies runtime-side); a PRESENT key is an
 * allowlist.
 */
export interface CapabilityCeiling {
  tools?: string[];
  mayAffect?: string[];
  secrets?: string[];
}

const CEILING_KEYS = ["tools", "mayAffect", "secrets"] as const;

function asAllowlist(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/** Read the ceiling keys out of a profile's capability JSONB, ignoring
 * anything else the sealed contract carries. */
export function ceilingOf(capability: Record<string, unknown> | undefined): CapabilityCeiling {
  const out: CapabilityCeiling = {};
  if (!capability) return out;
  for (const key of CEILING_KEYS) {
    const list = asAllowlist(capability[key]);
    if (list !== undefined) out[key] = list;
  }
  return out;
}

/**
 * intersectCeiling — the ONE rule of the delegation plane: a child's
 * effective ceiling is parent ∩ child, key by key. Absent ∩ X = X (absent is
 * unrestricted); present ∩ present = set intersection. The result is always
 * ⊆ each input — a child can never be wider than its parent, mechanically.
 */
export function intersectCeiling(parent: CapabilityCeiling, child: CapabilityCeiling): CapabilityCeiling {
  const out: CapabilityCeiling = {};
  for (const key of CEILING_KEYS) {
    const a = parent[key];
    const b = child[key];
    if (a === undefined && b === undefined) continue;
    if (a === undefined) {
      out[key] = [...b!];
    } else if (b === undefined) {
      out[key] = [...a];
    } else {
      const set = new Set(a);
      out[key] = b.filter((x) => set.has(x));
    }
  }
  return out;
}

// ── Budgets (saas-agents-fleet AF8) ─────────────────────────
// Ceilings, not advisories (locked decision 6): the door refuses a spawn
// against an exhausted envelope; an ingest crossing becomes a graceful,
// sealed interrupt — the log is worth more than the last 2% of budget.

export const BUDGET_GRAINS = ["workspace", "tree", "session", "routine"] as const;
export type BudgetGrain = (typeof BUDGET_GRAINS)[number];

/** The soft mark: crossing this fraction of a ceiling raises an attention
 * item; crossing 1.0 interrupts (design §7). */
export const BUDGET_SOFT_MARK = 0.8;

export const BUDGET_ERROR_CODES = {
  budgetInvalid: "agent_budget_invalid",
  budgetNotFound: "agent_budget_not_found",
  /** The applicable envelope is exhausted — refused at the door. */
  budgetExhausted: "budget_exhausted",
} as const;
export type BudgetErrorCode = (typeof BUDGET_ERROR_CODES)[keyof typeof BUDGET_ERROR_CODES];

/** A token ceiling. workspace/tree/session rows are org-wide defaults (no
 * ref); routine rows pin one routine's public id. */
export interface AgentBudget {
  /** Public id, `bud_…`. */
  id: string;
  grain: BudgetGrain;
  ref?: string;
  maxTokens: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** PUT /agents/budgets — upsert the ceiling for a grain(+ref). */
export interface SetBudgetRequest {
  grain: BudgetGrain;
  /** routine grain only: the routine's public id. */
  ref?: string;
  maxTokens: number;
}

// ── Track record & earned autonomy (saas-agents-fleet AF7) ──
// The record is a COMPUTED read over session rows + relayed events — never
// stored, never writable by an agent. Movement is asymmetric: promotion is
// suggested by the record and applied only by a human ack (with the
// server-computed evidence attached); demotion is automatic and loud. No
// sequence of agent actions can widen any leash.

/** A profile's track record — named rates with their numerators visible
 * (the work-plane meter discipline: no scores, no ranking). */
export interface AgentProfileRecord {
  profileId: string;
  /** Sessions considered (all-time in v1; windows ride orun AF3's fold). */
  sessions: number;
  byKind: Partial<Record<AgentRunKind, number>>;
  completed: number;
  failed: number;
  /** completed / (completed + failed); null until any run finishes. */
  completionRate: number | null;
  /** Terminal sessions that produced a PR artifact. */
  prProduced: number;
  /** Human verdicts asked / granted (agent-answered verdicts are EXCLUDED —
   * the record only counts human trust). */
  verdictAsks: number;
  verdictGrants: number;
  grantRate: number | null;
  /** Human steers observed (interventions). */
  steers: number;
  /** Tokens observed via relayed cost samples (the sampled sessions only). */
  tokensObserved: number;
}

/** The workspace promotion bar (F-Q4 — shipped as defaults, overridable via
 * the autonomy policy's caps.promotionBar). */
export interface PromotionBar {
  minSessions: number;
  minCompletionRate: number;
}

export const PROMOTION_BAR_DEFAULTS: PromotionBar = {
  minSessions: 20,
  minCompletionRate: 0.85,
};

/** The promotion assessment beside a record: eligible + the suggested next
 * rung. Suggests, never applies — the apply is a human PATCH. */
export interface PromotionAssessment {
  eligible: boolean;
  bar: PromotionBar;
  /** The rung above the profile's current level; absent at `full`. */
  suggested?: AgentAutonomyLevel;
}

/** The next rung up the ladder; null at the top. */
export function nextAutonomyLevel(level: AgentAutonomyLevel): AgentAutonomyLevel | null {
  const i = AGENT_AUTONOMY_LEVELS.indexOf(level);
  return i >= 0 && i < AGENT_AUTONOMY_LEVELS.length - 1 ? AGENT_AUTONOMY_LEVELS[i + 1]! : null;
}

/** The rung below; null at the floor (manual is never demotable further). */
export function previousAutonomyLevel(level: AgentAutonomyLevel): AgentAutonomyLevel | null {
  const i = AGENT_AUTONOMY_LEVELS.indexOf(level);
  return i > 0 ? AGENT_AUTONOMY_LEVELS[i - 1]! : null;
}

/** assessPromotion — pure: does the record clear the bar, and to where? */
export function assessPromotion(
  record: AgentProfileRecord,
  currentLevel: AgentAutonomyLevel,
  bar: PromotionBar = PROMOTION_BAR_DEFAULTS,
): PromotionAssessment {
  const suggested = nextAutonomyLevel(currentLevel);
  const eligible =
    suggested !== null &&
    record.sessions >= bar.minSessions &&
    record.completionRate !== null &&
    record.completionRate >= bar.minCompletionRate;
  return { eligible, bar, ...(eligible && suggested ? { suggested } : {}) };
}

/** GET /agents/records — the per-profile record + assessment, org-wide. */
export interface AgentRecordsEntry {
  profileId: string;
  autonomyDefault: AgentAutonomyLevel;
  record: AgentProfileRecord;
  promotion: PromotionAssessment;
}

/** PATCH /agents/profiles/:id — the human-ack autonomy movement. */
export interface SetProfileAutonomyRequest {
  autonomyDefault: AgentAutonomyLevel;
}

// ── Routines (saas-agents-fleet AF6) ────────────────────────
// Standing work: a trigger + binding that SPAWNS sessions through the AG9
// dispatch door (locked decision 3: there is no second way to start work).
// Success is digest material; two consecutive failed firings park the
// routine until a human resumes it.

export const ROUTINE_TRIGGER_KINDS = ["cron", "event"] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_KINDS)[number];

export const ROUTINE_ERROR_CODES = {
  routineNotFound: "agent_routine_not_found",
  routineConflict: "agent_routine_conflict",
  routineInvalid: "agent_routine_invalid",
  /** A parked/disabled routine refuses to fire until resumed/enabled. */
  routineNotLive: "agent_routine_not_live",
} as const;
export type RoutineErrorCode =
  (typeof ROUTINE_ERROR_CODES)[keyof typeof ROUTINE_ERROR_CODES];

/** Consecutive failed firings before the park latch closes (design §5.3). */
export const ROUTINE_PARK_THRESHOLD = 2;

export interface AgentRoutine {
  /** Public id, `rt_…`. */
  id: string;
  name: string;
  profileId: string;
  runKind: AgentRunKind;
  /** Content hash of the sealed RoutineSnapshot (orun AF2), when pinned. */
  definitionRef?: string;
  triggerKind: RoutineTriggerKind;
  /** cron: { cron: "0 7 * * *" } (5-field, hourly minimum); event: { lane, predicate }. */
  triggerConfig: Record<string, unknown>;
  caps: Record<string, unknown>;
  enabled: boolean;
  parked: boolean;
  parkedReason?: string;
  consecutiveFailures: number;
  lastFiredAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /agents/routines */
export interface CreateAgentRoutineRequest {
  name: string;
  profileId: string;
  runKind: AgentRunKind;
  triggerKind: RoutineTriggerKind;
  triggerConfig?: Record<string, unknown>;
  definitionRef?: string;
  caps?: Record<string, unknown>;
}

/** PATCH /agents/routines/:id — standing-state changes only. Resuming a
 * parked routine resets its failure count; the definition/trigger are
 * immutable (delete + recreate — the sealed-definition posture). */
export interface UpdateAgentRoutineRequest {
  enabled?: boolean;
  /** false = resume (only transition allowed; parking is automatic). */
  parked?: boolean;
}

// ── The attention plane (saas-agents-fleet AF5) ─────────────
// The needs-you fold: a computed read over facts already stored — session
// states, budget marks, routine parks, lease health. There is no stored inbox
// row and no dismiss verb; acting on an item removes it by making its source
// fact false (design §4.1: attention is derived, never authored).

/**
 * The closed attention-source vocabulary. Enum-complete from day one:
 * `budget` items appear once AF8 lands budgets, `routine_parked` once AF6
 * lands routines — both fold to zero until then.
 */
export const ATTENTION_KINDS = [
  /** A session is blocked on a human verdict (`awaiting_approval`). */
  "verdict",
  /** A live session/tree crossed its budget's soft mark (AF8). */
  "budget",
  /** A routine parked after repeated failures and needs a resume (AF6). */
  "routine_parked",
  /** A session failed on a task with retry budget left — re-dispatch offer. */
  "failed_retryable",
  /** A live session's lease lapsed but the sweep has not reclaimed it yet. */
  "stuck",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** Rank by kind — the queue's sort order (design §4.1). Lower renders first. */
export const ATTENTION_RANK: Record<AttentionKind, number> = {
  verdict: 1,
  budget: 2,
  routine_parked: 3,
  failed_retryable: 4,
  stuck: 5,
};

/**
 * One needs-you item. Every item carries its provenance — the session or
 * routine, the work pointer, and the fact that produced it — so the fold
 * shows its arithmetic.
 */
export interface AttentionItem {
  kind: AttentionKind;
  /** The session the item is about (`as_…`); absent on routine items. */
  sessionId?: string;
  /** The routine the item is about (`rt_…`) — routine_parked items (AF6). */
  routineId?: string;
  profileId?: string;
  runKind?: AgentRunKind;
  state?: AgentSessionState;
  workRef?: string;
  taskKey?: string;
  /** The producing fact, human-readable ("wants to run npx wrangler deploy"). */
  reason: string;
  /** When the underlying fact arose (approval asked / lease lapsed / ended). */
  at: string;
  /** verdict items: the pending request, answerable from the fleet home. */
  request?: { requestId: string; tool: string };
}

/** GET /v1/organizations/{orgId}/agents/attention */
export interface AttentionSummary {
  /** Ranked (ATTENTION_RANK asc, then oldest fact first). */
  items: AttentionItem[];
  /** Per-kind counts, every kind always present (zero included). */
  counts: Record<AttentionKind, number>;
  /** Sessions currently `running` — the fleet home's other stat numeral. */
  running: number;
}

// ── The roster fold (saas-agent-supervision SV1) ────────────
// "This thread's implementers" is a FOLD over sessions by origin + live state,
// never a stored second truth: the implementers whose origin is
// {kind:"dispatch", ref:<thread ch_…>}. Per-viewer, `session.read`-gated,
// viewer-credentialed (DX lock 4). The panel renders the active ones; terminal
// implementers live on the Implementers surface (SV4) and only fold to a count
// here.

/**
 * One active implementer on a thread's roster: the session itself (carrying
 * state / origin / cost), the delegation tier resolved from its profile (the
 * DD10 "render, never average" chip), and whether it currently needs a human.
 */
export interface RosterImplementer {
  session: AgentSession;
  /** The profile's delegation interface (DX7) — the tier chip. Defaults to
   * `orun-sandbox` when the profile can't be resolved. */
  interface: DelegationInterface;
  /** The needs-you fact (AF6) when this implementer is waiting on a human —
   * the SAME fold the attention plane renders (one truth), or absent. */
  needsYou?: AttentionItem;
}

/** GET /v1/organizations/{orgId}/agents/chats/{chatId}/implementers */
export interface ChatImplementers {
  /** The dispatcher thread this roster folds (`ch_…`). */
  chatId: string;
  /** Active (non-terminal) implementers, newest first. */
  active: RosterImplementer[];
  /** Active implementers currently running — the "N running" numeral. */
  running: number;
  /** Active implementers waiting on a human — the "M waiting on you" numeral. */
  needsYou: number;
  /** Terminal implementers of this thread (shown on the Implementers surface,
   * counted here) — the "K done" numeral. */
  done: number;
}

// ── The supervision loop (saas-agent-supervision SV3) ───────
// The dispatcher wakes on its implementers' events, not on a poll. The wake
// set is a CLOSED subset of the session-event vocabulary (plus one computed
// `stuck` marker); rings within a coalescing window collapse into one bounded,
// typed digest built from SEALED events (never raw log text — §9.2); the
// thread runs a rate-limited, budgeted, injection-hardened supervisor turn.

/**
 * Wake kinds — the ONLY events that cause a supervisor turn (design §4.1).
 * Everything else (tool ticks, deltas, cost samples below a mark) is read
 * *during* a turn if the dispatcher chooses; it never causes one. `stuck` is
 * computed by the index (no stored status), not a relayed kind.
 */
export const WAKE_KINDS = [
  /** state_changed → a terminal state (completed|failed|canceled|expired). */
  "terminal",
  /** approval_requested — escalation (never resolved; §4.4). */
  "approval",
  /** AF9 budget mark crossed / budget_exhausted interrupt. */
  "budget",
  /** child_spawned / child_completed / child_failed on a roster root. */
  "child",
  /** No event past the per-profile silence threshold while running. */
  "stuck",
] as const;
export type WakeKind = (typeof WAKE_KINDS)[number];

/** Wake kinds that ALWAYS ring, regardless of cause chain — a terminal state
 * or an approval is never suppressed by the reflexivity filter (§4.5). */
export const ALWAYS_WAKE_KINDS: readonly WakeKind[] = ["terminal", "approval"];

/**
 * One entry in a supervisor turn's digest: a typed, bounded summary of a
 * sealed wake event — never raw log text. `headline` is a short, safe rendering
 * ("as_9f… completed", "wants to run wrangler deploy"); the model treats the
 * digest as untrusted structured data (§9.2).
 */
export interface DigestEntry {
  sessionId: string;
  origin: AgentOrigin;
  wake: WakeKind;
  /** The relayed event kind that produced it (for the record). */
  eventKind: AgentSessionEventKind;
  /** Sealed event seq — the dedupe + ordering key. */
  seq: number;
  headline: string;
  at: string;
}

/** Max entries a digest carries before it collapses to "+K more" (§ open-q 4).
 * Terminal + approval entries are always kept; progress is what falls off. */
export const DIGEST_ENTRY_CAP = 12;

/**
 * The coalesced wake digest a supervisor turn runs on (design §4.2). Built
 * from sealed events within one coalescing window; bounded by DIGEST_ENTRY_CAP.
 */
export interface SupervisionDigest {
  chatId: string;
  entries: DigestEntry[];
  /** Entries dropped past the cap (progress only — terminal/approval kept). */
  overflow: number;
  /** How many raw wake events coalesced into this digest. */
  coalesced: number;
}

/** Default coalescing window (design §4.2): rings within this collapse to one
 * digest, per thread. */
export const SUPERVISION_COALESCE_MS = 5_000;

/**
 * Per-thread supervision mode (design §4.5). `on` runs supervisor turns;
 * `observe` folds digests + posts cards but calls no model (the cost dial);
 * `off` is doorbell-only (zero). New threads default `on` (flipped from
 * `observe` per-workspace after SV5 enforcement — open question 1).
 */
export const SUPERVISION_MODES = ["on", "observe", "off"] as const;
export type SupervisionMode = (typeof SUPERVISION_MODES)[number];

export function isSupervisionMode(v: string): v is SupervisionMode {
  return (SUPERVISION_MODES as readonly string[]).includes(v);
}

/**
 * The SV3 thread-card registry (design §7.3): closed CUSTOM payloads a
 * supervisor turn posts. Versioned like the other AG-UI CUSTOM cards.
 */
export const SUPERVISION_CARD_KINDS = [
  /** Terminal state + the dispatcher's verification against the ask. */
  "completion",
  /** A meaningful transition a supervisor turn surfaced (never a firehose). */
  "progress",
  /** An implementer wants a human verdict — deep-links, NEVER resolves (§4.4). */
  "escalation",
  /** The foreman roll-up ("N running · M waiting on you · K done") — SV7. */
  "rollup",
] as const;
export type SupervisionCardKind = (typeof SUPERVISION_CARD_KINDS)[number];

/**
 * The escalation card (design §4.4). The supervisor turn's ONLY power on an
 * approval is to make the human's decision easy: the tool, the policy reason,
 * the implementer's own justification quoted AS DATA, and a deep link to the
 * cockpit where the human answers through the credentialed verdict path. It
 * points at the attention plane; it never drains it. There is deliberately no
 * verdict field — approvals are human (AN lock 5).
 */
export interface EscalationCard {
  kind: "escalation";
  sessionId: string;
  origin: AgentOrigin;
  /** The tool the implementer wants to run (the ask). */
  tool: string;
  /** The pending request id — answered on the cockpit, never here. */
  requestId: string;
  /** The implementer's justification, quoted as untrusted data. */
  justification?: string;
  at: string;
}

// ── Provider connections (AG12) ─────────────────────────────
// BYO provider accounts: a workspace connects its own sandbox-compute account
// (Daytona) and one or more model-provider keys (Anthropic, OpenAI,
// OpenRouter, …). The key is write-only (custody in the secret manager under
// the reserved agents/providers/* namespace); these wire shapes never carry
// key material beyond the one-shot create request.

export const AGENT_PROVIDERS = ["daytona", "anthropic", "openai", "openrouter"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/** The sandbox-compute providers — sessions run inside these. */
export const COMPUTE_PROVIDERS = ["daytona"] as const;
export type ComputeProvider = (typeof COMPUTE_PROVIDERS)[number];

/**
 * Model-credential providers. A session/chat reads the resolved key from its
 * environment; OpenAI and OpenRouter are OpenAI-compatible, so a connection
 * MAY carry a `baseUrl` in `config` to point at a compatible gateway, plus an
 * optional `defaultModel`. The key custody + verification path is identical
 * across all of them — only the verification endpoint differs.
 */
export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(p: string): p is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(p);
}

export const PROVIDER_CONNECTION_STATUSES = ["unverified", "verified", "invalid"] as const;
export type ProviderConnectionStatus = (typeof PROVIDER_CONNECTION_STATUSES)[number];

export const PROVIDER_ERROR_CODES = {
  providerUnsupported: "provider_unsupported",
  connectionNotFound: "provider_connection_not_found",
  connectionConflict: "provider_connection_conflict",
  connectionInvalid: "provider_connection_invalid",
  /** The verification ping against the provider failed. */
  verificationFailed: "provider_verification_failed",
} as const;
export type ProviderErrorCode =
  (typeof PROVIDER_ERROR_CODES)[keyof typeof PROVIDER_ERROR_CODES];

/** A connected provider account — safe projection (no key material). */
export interface ProviderConnection {
  /** Public id, `apc_…`. */
  id: string;
  provider: AgentProvider;
  name: string;
  /** Non-secret provider config — daytona: {apiUrl?, orgId?, target?}; model
   * providers: {defaultModel?, baseUrl?} (baseUrl overrides the vendor default,
   * e.g. an OpenAI-compatible gateway). Never key material. */
  config: Record<string, unknown>;
  /** Write-only key display hint, e.g. `…abcd`. Never the key. */
  keyHint?: string;
  status: ProviderConnectionStatus;
  lastVerifiedAt?: string;
  /** Redacted verification failure ("401 from provider"); never key material. */
  statusReason?: string;
  /**
   * saas-integration-registry IR5: public id (`int_…`) of this connection's
   * identity row in `integrations.connections` — the same row the unified
   * Integrations hub and provider spaces list. Absent on pre-backfill rows
   * for one release (dual-read tolerance). Additive.
   */
  connectionId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /v1/organizations/{orgId}/agents/providers — the one-shot create.
 *  `apiKey` is consumed at the boundary (forwarded to secret custody) and is
 *  never stored on, or readable from, the connection. */
export interface CreateProviderConnectionRequest {
  provider: AgentProvider;
  name?: string;
  apiKey: string;
  config?: Record<string, unknown>;
}
