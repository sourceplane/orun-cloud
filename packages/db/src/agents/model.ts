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

/** The closed session-event vocabulary — no status/lifecycle kind exists. */
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
