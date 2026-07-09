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
  /** The base snapshot to boot from (ships the orun binary + drivers). */
  baseSnapshot: string;
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
  /** Start `orun agent serve` (or any command) in the sandbox. */
  exec(ref: SandboxRef, cmd: string[], opts?: { env?: Record<string, string> }): Promise<void>;
  snapshot(ref: SandboxRef): Promise<string>;
  resume(snapshotId: string): Promise<SandboxRef>;
  destroy(ref: SandboxRef): Promise<void>;
  health(ref: SandboxRef): Promise<SandboxHealth>;
}
