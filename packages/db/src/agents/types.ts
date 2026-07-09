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

  appendSessionEvent(scope: WorkspaceScope, input: AppendSessionEventInput): Promise<void>;
  listSessionEvents(scope: WorkspaceScope, sessionPublicId: string): Promise<SessionEvent[]>;

  setAutonomy(scope: WorkspaceScope, input: SetAutonomyInput): Promise<AutonomyPolicy>;
  getAutonomy(scope: WorkspaceScope, specKey?: string): Promise<AutonomyPolicy | null>;
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
