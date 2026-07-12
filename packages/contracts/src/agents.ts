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

/** Run kinds — mirrors the orun runtime's nodes.RunKind*. */
export const AGENT_RUN_KINDS = [
  "design",
  "implementation",
  "interactive",
  "fix",
] as const;
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];

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
  autonomyDefault: AgentAutonomyLevel;
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
  snapshot(ref: SandboxRef): Promise<string>;
  resume(snapshotId: string): Promise<SandboxRef>;
  destroy(ref: SandboxRef): Promise<void>;
  health(ref: SandboxRef): Promise<SandboxHealth>;
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
 * One needs-you item. Every item carries its provenance — the session, the
 * work pointer, and the fact that produced it — so the fold shows its
 * arithmetic. All v1 kinds are session-backed; routine items gain a
 * routineId in AF6.
 */
export interface AttentionItem {
  kind: AttentionKind;
  /** The session the item is about (`as_…`). */
  sessionId: string;
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

// ── Provider connections (AG12) ─────────────────────────────
// BYO provider accounts: a workspace connects its own Daytona account and
// Anthropic key. The key is write-only (custody in the secret manager under
// the reserved agents/providers/* namespace); these wire shapes never carry
// key material beyond the one-shot create request.

export const AGENT_PROVIDERS = ["daytona", "anthropic"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

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
  /** Non-secret provider config (daytona: apiUrl/orgId/target; anthropic: defaultModel). */
  config: Record<string, unknown>;
  /** Write-only key display hint, e.g. `…abcd`. Never the key. */
  keyHint?: string;
  status: ProviderConnectionStatus;
  lastVerifiedAt?: string;
  /** Redacted verification failure ("401 from provider"); never key material. */
  statusReason?: string;
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
