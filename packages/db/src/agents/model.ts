// Agent-session control-plane model (saas-agents AG5/AG6) — pure types +
// closed vocabularies + validators. No I/O.
//
// The runtime is the orun binary; this plane hosts it. These rows are
// infrastructure facts about sessions + agent-plane configuration, never
// work-plane truth. There is no status/lifecycle mutator here by design.
//
// Spec: specs/epics/saas-agents/, runtime orun/specs/orun-agents/.

export const API_VERSION = "orun.io/v1" as const;

export const SESSION_STATES = [
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
export type SessionState = (typeof SESSION_STATES)[number];

export const TERMINAL_STATES: readonly SessionState[] = [
  "completed",
  "failed",
  "canceled",
  "expired",
];

export function isTerminal(s: SessionState): boolean {
  return TERMINAL_STATES.includes(s);
}

/**
 * Allowed control-plane transitions. The runtime advances a session through
 * these infrastructure states; a terminal state has no outgoing edges. This is
 * NOT the work lifecycle (that is derived by the work fold).
 */
const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  requested: ["provisioning", "failed", "canceled"],
  provisioning: ["running", "failed", "canceled"],
  running: ["awaiting_approval", "suspended", "completing", "failed", "canceled"],
  awaiting_approval: ["running", "suspended", "completing", "failed", "canceled"],
  suspended: ["running", "expired", "canceled"],
  completing: ["completed", "failed"],
  completed: [],
  failed: [],
  canceled: [],
  expired: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export const RUN_KINDS = ["design", "implementation", "interactive", "fix"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const AUTONOMY_LEVELS = ["manual", "assist", "auto-dispatch", "full"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** The closed session-event vocabulary — no status/lifecycle kind exists.
 * The child_* kinds (saas-agents-fleet AF4) are the parent's sealed story of
 * its delegation tree, emitted by the runtime and relayed like everything
 * else — they narrate infrastructure facts, never work progress. */
export const SESSION_EVENT_KINDS = [
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
  "child_spawned",
  "child_completed",
  "child_failed",
] as const;
export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

export class AgentsError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentsError";
  }
}

// ── Row shapes ──────────────────────────────────────────────

export interface AgentProfile {
  id: string;
  publicId: string;
  orgId: string;
  name: string;
  principalId: string;
  owner: string;
  agentType: string;
  harness: string;
  model: string;
  autonomyDefault: AutonomyLevel;
  capability: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  publicId: string;
  orgId: string;
  profileId: string;
  runKind: RunKind;
  state: SessionState;
  workRef?: string;
  taskKey?: string;
  prUrl?: string;
  snapshotId?: string;
  sandbox: Record<string, unknown>;
  spawnedBy: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  /** Delegation tree (saas-agents-fleet AF4) — public-id keyed, a tree never
   * a graph. A root is its own rootSessionId at depth 0. */
  parentSessionId?: string;
  rootSessionId: string;
  depth: number;
  /** Routine provenance (AF6): the firing routine's public id, when fired. */
  routineId?: string;
}

export interface SessionEvent {
  seq: number;
  kind: SessionEventKind;
  payload: Record<string, unknown>;
  ref?: string;
  at: string;
}

export interface AutonomyPolicy {
  orgId: string;
  specKey?: string;
  level: AutonomyLevel;
  caps: Record<string, unknown>;
  updatedAt: string;
}

// ── Validators ──────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function validateProfileInput(input: {
  name: string;
  principalId: string;
  owner: string;
  agentType: string;
}): void {
  if (!NAME_RE.test(input.name)) {
    throw new AgentsError("agent_profile_invalid", `profile name ${JSON.stringify(input.name)} invalid`);
  }
  if (!input.principalId) {
    throw new AgentsError("agent_profile_invalid", "profile principalId required");
  }
  // The work-plane rule adopted platform-wide: no responsible owner, no profile.
  if (!input.owner) {
    throw new AgentsError("agent_profile_invalid", "profile owner (responsible owner) is mandatory");
  }
  if (!input.agentType) {
    throw new AgentsError("agent_profile_invalid", "profile agentType required");
  }
}

export function isSessionEventKind(k: string): k is SessionEventKind {
  return (SESSION_EVENT_KINDS as readonly string[]).includes(k);
}

export function validateSessionEvent(e: { seq: number; kind: string }): void {
  if (!Number.isInteger(e.seq) || e.seq < 0) {
    throw new AgentsError("agent_session_event_invalid", `event seq ${e.seq} invalid`);
  }
  if (!isSessionEventKind(e.kind)) {
    // A status/lifecycle kind is unrepresentable — the honesty invariant.
    throw new AgentsError("agent_session_event_invalid", `event kind ${JSON.stringify(e.kind)} not in the closed vocabulary`);
  }
}

// ── Routines (saas-agents-fleet AF6) ────────────────────────

export const ROUTINE_TRIGGER_KINDS = ["cron", "event"] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_KINDS)[number];

/**
 * A standing routine: trigger + binding configuration. A routine only ever
 * SPAWNS sessions (every firing re-enters the dispatch door); the only
 * execution state here is the park latch and the last-fired mark.
 */
export interface Routine {
  id: string;
  publicId: string;
  orgId: string;
  name: string;
  profileId: string;
  runKind: RunKind;
  /** Content hash of the sealed RoutineSnapshot (orun AF2), when pinned. */
  definitionRef?: string;
  triggerKind: RoutineTriggerKind;
  /** cron: { cron: "0 7 * * *" }; event: { lane, predicate } (ES1). */
  triggerConfig: Record<string, unknown>;
  /** Budget stub until AF8 binds real ceilings. */
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

const ROUTINE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function validateRoutineInput(input: { name: string; triggerKind: string }): void {
  if (!ROUTINE_NAME_RE.test(input.name)) {
    throw new AgentsError("agent_routine_invalid", `routine name ${JSON.stringify(input.name)} invalid`);
  }
  if (!(ROUTINE_TRIGGER_KINDS as readonly string[]).includes(input.triggerKind)) {
    throw new AgentsError("agent_routine_invalid", `trigger ${JSON.stringify(input.triggerKind)} not cron|event`);
  }
}

// ── Provider connections (AG12) ─────────────────────────────

/** Providers a workspace can connect (design §10). */
export const PROVIDERS = ["daytona", "anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(p: string): p is Provider {
  return (PROVIDERS as readonly string[]).includes(p);
}

/** Connection verification states — infrastructure facts from provider pings. */
export const CONNECTION_STATUSES = ["unverified", "verified", "invalid"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * A workspace's connected provider account. The API key is NOT here — it lives
 * in the secret manager under secretRef (reserved agents/providers/*
 * namespace); keyHint carries a last4 display hint only.
 */
export interface ProviderConnection {
  id: string;
  publicId: string;
  orgId: string;
  provider: Provider;
  name: string;
  config: Record<string, unknown>;
  secretRef: string;
  keyHint?: string;
  status: ConnectionStatus;
  lastVerifiedAt?: string;
  statusReason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The reserved secret-manager key a connection's API key is stored under. */
export function providerSecretRef(provider: Provider, name: string): string {
  return `agents/providers/${provider}/${name}/API_KEY`;
}

export function validateConnectionInput(input: { provider: string; name: string }): void {
  if (!isProvider(input.provider)) {
    throw new AgentsError("provider_unsupported", `provider ${JSON.stringify(input.provider)} not supported`);
  }
  if (!CONNECTION_NAME_RE.test(input.name)) {
    throw new AgentsError("provider_connection_invalid", `connection name ${JSON.stringify(input.name)} invalid`);
  }
}
