// Repository contract for the agent-session control plane (saas-agents AG5/AG6).
//
// Sessions are hosted runs of the orun runtime; the system of record for what
// the agent DID is the sealed AgentSessionSnapshot in orun's object graph.
// This repository owns the control-plane projection: profiles, session
// infrastructure state, the relayed event mirror, and autonomy policy. It has
// no work-status mutator — the work fold owns lifecycle.

import type {
  AgentProfile,
  AgentSession,
  AutonomyLevel,
  AutonomyPolicy,
  ConnectionStatus,
  Provider,
  ProviderConnection,
  Routine,
  RoutineTriggerKind,
  RunKind,
  SessionEvent,
  SessionEventKind,
  SessionState,
} from "./model.js";

export interface WorkspaceScope {
  orgId: string;
}

export interface CreateProfileInput {
  name: string;
  principalId: string;
  owner: string;
  agentType: string;
  harness: string;
  model: string;
  autonomyDefault?: AutonomyLevel;
  capability?: Record<string, unknown>;
}

export interface CreateSessionInput {
  profileId: string;
  runKind: RunKind;
  spawnedBy: string;
  workRef?: string;
  taskKey?: string;
  /** Delegation (AF4): the PARENT session's public id. The child inherits the
   * parent's root and depth+1. The spawn door supplies this from the actor's
   * session binding — never from a request body. */
  parentSessionId?: string;
  /** Create-time infrastructure facts (AF4: the applied capability ceiling). */
  sandbox?: Record<string, unknown>;
  /** Routine provenance (AF6): the firing routine's public id. */
  routineId?: string;
}

export interface AdvanceSessionInput {
  publicId: string;
  to: SessionState;
  /** Set on terminal states / PR production. */
  prUrl?: string;
  snapshotId?: string;
  leaseExpiresAt?: string;
  sandbox?: Record<string, unknown>;
}

export interface AppendSessionEventInput {
  sessionPublicId: string;
  seq: number;
  kind: SessionEventKind;
  payload?: Record<string, unknown>;
  ref?: string;
}

export interface ListLapsedSessionsInput {
  /** Sessions in running/awaiting_approval with a lease older than this. */
  leaseCutoff: string;
  /** Provisioning sessions created before this never booted — reclaim them. */
  provisioningCutoff: string;
  limit: number;
}

export interface ListOrphanedSessionsInput {
  /** Live children whose parent reached a terminal state before this are
   * orphans — a tree cannot outlive its root's intent (AF4 §3.2). */
  parentEndedCutoff: string;
  limit: number;
}

export interface SetAutonomyInput {
  specKey?: string;
  level: AutonomyLevel;
  caps?: Record<string, unknown>;
}

/**
 * The control-plane repository. Every method is workspace-scoped. Terminal
 * transitions are guarded by the model's transition table; an illegal
 * transition throws rather than corrupting state.
 */
export interface AgentsRepository extends ProviderConnectionsRepository {
  createProfile(scope: WorkspaceScope, input: CreateProfileInput): Promise<AgentProfile>;
  getProfile(scope: WorkspaceScope, name: string): Promise<AgentProfile | null>;
  listProfiles(scope: WorkspaceScope): Promise<AgentProfile[]>;

  createSession(scope: WorkspaceScope, input: CreateSessionInput): Promise<AgentSession>;
  getSession(scope: WorkspaceScope, publicId: string): Promise<AgentSession | null>;
  listSessions(scope: WorkspaceScope, filter?: { state?: SessionState }): Promise<AgentSession[]>;
  advanceSession(scope: WorkspaceScope, input: AdvanceSessionInput): Promise<AgentSession>;
  /** The profile a session runs as — the runtime credential gate joins the
   * session's service principal through this (AG6 §3). */
  getSessionProfile(scope: WorkspaceScope, sessionPublicId: string): Promise<AgentProfile | null>;
  /** Extend the session lease (heartbeat) without a state transition. Refuses
   * on terminal states — a dead session's lease never revives. */
  touchSessionLease(scope: WorkspaceScope, sessionPublicId: string, leaseExpiresAt: string): Promise<AgentSession>;
  /** CROSS-ORG reclaim query for the lease sweep (design §4.3): active
   * sessions whose lease lapsed, plus provisioning sessions stalled past the
   * boot horizon (they never heartbeat, so they never earn a lease). */
  listLapsedSessions(input: ListLapsedSessionsInput): Promise<AgentSession[]>;
  /** CROSS-ORG orphan query (AF4): non-terminal children whose parent went
   * terminal past the grace window — the sweep converges the tree. */
  listOrphanedSessions(input: ListOrphanedSessionsInput): Promise<AgentSession[]>;

  appendSessionEvent(scope: WorkspaceScope, input: AppendSessionEventInput): Promise<void>;
  listSessionEvents(scope: WorkspaceScope, sessionPublicId: string): Promise<SessionEvent[]>;

  setAutonomy(scope: WorkspaceScope, input: SetAutonomyInput): Promise<AutonomyPolicy>;
  getAutonomy(scope: WorkspaceScope, specKey?: string): Promise<AutonomyPolicy | null>;

  // ── Routines (saas-agents-fleet AF6) ──────────────────────
  createRoutine(scope: WorkspaceScope, input: CreateRoutineInput): Promise<Routine>;
  getRoutine(scope: WorkspaceScope, publicId: string): Promise<Routine | null>;
  listRoutines(scope: WorkspaceScope): Promise<Routine[]>;
  /** Mutate the standing state: enable/disable, park/resume (resume resets
   * the failure count), the last-fired mark, the failure counter. */
  updateRoutineState(scope: WorkspaceScope, input: UpdateRoutineStateInput): Promise<Routine>;
  deleteRoutine(scope: WorkspaceScope, publicId: string): Promise<boolean>;
  /** CROSS-ORG scan for the scheduler tick: enabled, unparked routines. */
  listLiveRoutines(limit: number): Promise<Routine[]>;
  /** The most recent sessions a routine fired, newest first (park math). */
  listRoutineSessions(scope: WorkspaceScope, routinePublicId: string, limit: number): Promise<AgentSession[]>;
}

export interface CreateRoutineInput {
  name: string;
  profileId: string;
  runKind: RunKind;
  triggerKind: RoutineTriggerKind;
  triggerConfig?: Record<string, unknown>;
  definitionRef?: string;
  caps?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateRoutineStateInput {
  publicId: string;
  enabled?: boolean;
  parked?: boolean;
  parkedReason?: string | null;
  consecutiveFailures?: number;
  lastFiredAt?: string;
}

// ── Provider connections (AG12) ─────────────────────────────

export interface CreateConnectionInput {
  provider: string;
  name: string;
  config?: Record<string, unknown>;
  secretRef: string;
  keyHint?: string;
  createdBy: string;
}

export interface SetConnectionStatusInput {
  publicId: string;
  status: ConnectionStatus;
  statusReason?: string;
}

export interface ProviderConnectionsRepository {
  createConnection(
    scope: WorkspaceScope,
    input: CreateConnectionInput,
  ): Promise<ProviderConnection>;
  listConnections(
    scope: WorkspaceScope,
    provider?: Provider,
  ): Promise<ProviderConnection[]>;
  getConnection(
    scope: WorkspaceScope,
    publicId: string,
  ): Promise<ProviderConnection | null>;
  setConnectionStatus(
    scope: WorkspaceScope,
    input: SetConnectionStatusInput,
  ): Promise<ProviderConnection>;
  deleteConnection(scope: WorkspaceScope, publicId: string): Promise<boolean>;
}
