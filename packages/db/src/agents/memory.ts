// In-memory AgentsRepository — the test double and executable contract. Same
// rules as the Postgres impl: transitions guarded, event vocabulary closed,
// dedupe on (session, seq), no work-status surface.

import {
  AgentsError,
  canTransition,
  isTerminal,
  validateConnectionInput,
  validateProfileInput,
  validateSessionEvent,
  type AgentProfile,
  type AgentSession,
  type AutonomyPolicy,
  type Provider,
  type ProviderConnection,
  type SessionEvent,
  type SessionState,
} from "./model.js";
import type {
  AdvanceSessionInput,
  AgentsRepository,
  AppendSessionEventInput,
  CreateConnectionInput,
  CreateProfileInput,
  CreateSessionInput,
  ListLapsedSessionsInput,
  SetAutonomyInput,
  SetConnectionStatusInput,
  WorkspaceScope,
} from "./types.js";

interface Stored {
  profiles: AgentProfile[];
  sessions: AgentSession[];
  events: Map<string, SessionEvent[]>; // session publicId → events
  eventSeqs: Map<string, Set<number>>;
  policies: AutonomyPolicy[];
  connections: ProviderConnection[];
}

export class MemoryAgentsRepository implements AgentsRepository {
  private byOrg = new Map<string, Stored>();
  private seq = 0;
  private now: () => string;

  constructor(opts?: { now?: () => string }) {
    // Injectable clock so tests are deterministic; defaults to a monotonic
    // counter rather than wall-clock (kept side-effect-free and ordered).
    let n = 0;
    this.now = opts?.now ?? (() => `1970-01-01T00:00:${String(n++).padStart(2, "0")}.000Z`);
  }

  private store(orgId: string): Stored {
    let s = this.byOrg.get(orgId);
    if (!s) {
      s = { profiles: [], sessions: [], events: new Map(), eventSeqs: new Map(), policies: [], connections: [] };
      this.byOrg.set(orgId, s);
    }
    return s;
  }

  private id(prefix: string): string {
    return `${prefix}${(this.seq++).toString(36).padStart(6, "0")}`;
  }

  async createProfile(scope: WorkspaceScope, input: CreateProfileInput): Promise<AgentProfile> {
    validateProfileInput(input);
    const s = this.store(scope.orgId);
    if (s.profiles.some((p) => p.name === input.name)) {
      throw new AgentsError("agent_profile_conflict", `profile ${input.name} exists`);
    }
    const ts = this.now();
    const profile: AgentProfile = {
      id: this.id("id_"),
      publicId: this.id("agp_"),
      orgId: scope.orgId,
      name: input.name,
      principalId: input.principalId,
      owner: input.owner,
      agentType: input.agentType,
      harness: input.harness,
      model: input.model,
      autonomyDefault: input.autonomyDefault ?? "assist",
      capability: input.capability ?? {},
      createdAt: ts,
      updatedAt: ts,
    };
    s.profiles.push(profile);
    return profile;
  }

  async getProfile(scope: WorkspaceScope, name: string): Promise<AgentProfile | null> {
    return this.store(scope.orgId).profiles.find((p) => p.name === name) ?? null;
  }

  async listProfiles(scope: WorkspaceScope): Promise<AgentProfile[]> {
    return [...this.store(scope.orgId).profiles].sort((a, b) => a.name.localeCompare(b.name));
  }

  async createSession(scope: WorkspaceScope, input: CreateSessionInput): Promise<AgentSession> {
    const s = this.store(scope.orgId);
    const profile = s.profiles.find((p) => p.id === input.profileId || p.publicId === input.profileId);
    if (!profile) {
      throw new AgentsError("agent_profile_not_found", `profile ${input.profileId} not found`);
    }
    const session: AgentSession = {
      id: this.id("id_"),
      publicId: this.id("as_"),
      orgId: scope.orgId,
      profileId: profile.id,
      runKind: input.runKind,
      state: "requested",
      spawnedBy: input.spawnedBy,
      sandbox: {},
      createdAt: this.now(),
      ...(input.workRef !== undefined ? { workRef: input.workRef } : {}),
      ...(input.taskKey !== undefined ? { taskKey: input.taskKey } : {}),
    };
    s.sessions.push(session);
    return session;
  }

  async getSession(scope: WorkspaceScope, publicId: string): Promise<AgentSession | null> {
    return this.store(scope.orgId).sessions.find((x) => x.publicId === publicId) ?? null;
  }

  async getSessionProfile(scope: WorkspaceScope, sessionPublicId: string): Promise<AgentProfile | null> {
    const s = this.store(scope.orgId);
    const session = s.sessions.find((x) => x.publicId === sessionPublicId);
    if (!session) return null;
    return s.profiles.find((p) => p.id === session.profileId) ?? null;
  }

  async touchSessionLease(
    scope: WorkspaceScope,
    sessionPublicId: string,
    leaseExpiresAt: string,
  ): Promise<AgentSession> {
    const session = await this.getSession(scope, sessionPublicId);
    if (!session) {
      throw new AgentsError("agent_session_not_found", `session ${sessionPublicId} not found`);
    }
    if (isTerminal(session.state)) {
      throw new AgentsError("agent_session_bad_transition", `session is ${session.state}; lease cannot revive it`);
    }
    session.leaseExpiresAt = leaseExpiresAt;
    return session;
  }

  async listLapsedSessions(input: ListLapsedSessionsInput): Promise<AgentSession[]> {
    const out: AgentSession[] = [];
    for (const s of this.byOrg.values()) {
      for (const session of s.sessions) {
        const lapsed =
          (session.state === "running" || session.state === "awaiting_approval") &&
          session.leaseExpiresAt !== undefined &&
          session.leaseExpiresAt < input.leaseCutoff;
        const stalled = session.state === "provisioning" && session.createdAt < input.provisioningCutoff;
        if (lapsed || stalled) out.push(session);
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, input.limit);
  }

  async listSessions(scope: WorkspaceScope, filter?: { state?: SessionState }): Promise<AgentSession[]> {
    let rows = this.store(scope.orgId).sessions;
    if (filter?.state) rows = rows.filter((x) => x.state === filter.state);
    return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async advanceSession(scope: WorkspaceScope, input: AdvanceSessionInput): Promise<AgentSession> {
    const session = await this.getSession(scope, input.publicId);
    if (!session) {
      throw new AgentsError("agent_session_not_found", `session ${input.publicId} not found`);
    }
    if (!canTransition(session.state, input.to)) {
      throw new AgentsError("agent_session_bad_transition", `${session.state} → ${input.to} not allowed`);
    }
    session.state = input.to;
    if (input.prUrl !== undefined) session.prUrl = input.prUrl;
    if (input.snapshotId !== undefined) session.snapshotId = input.snapshotId;
    if (input.leaseExpiresAt !== undefined) session.leaseExpiresAt = input.leaseExpiresAt;
    if (input.sandbox !== undefined) session.sandbox = input.sandbox;
    if (session.startedAt === undefined && input.to === "running") session.startedAt = this.now();
    if (isTerminal(input.to)) session.endedAt = this.now();
    return session;
  }

  async appendSessionEvent(scope: WorkspaceScope, input: AppendSessionEventInput): Promise<void> {
    validateSessionEvent(input);
    const s = this.store(scope.orgId);
    if (!s.sessions.some((x) => x.publicId === input.sessionPublicId)) {
      throw new AgentsError("agent_session_not_found", `session ${input.sessionPublicId} not found`);
    }
    let seqs = s.eventSeqs.get(input.sessionPublicId);
    if (!seqs) {
      seqs = new Set();
      s.eventSeqs.set(input.sessionPublicId, seqs);
    }
    if (seqs.has(input.seq)) return; // dedupe on (session, seq)
    seqs.add(input.seq);
    const list = s.events.get(input.sessionPublicId) ?? [];
    list.push({
      seq: input.seq,
      kind: input.kind,
      payload: input.payload ?? {},
      at: this.now(),
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
    });
    s.events.set(input.sessionPublicId, list);
  }

  async listSessionEvents(scope: WorkspaceScope, sessionPublicId: string): Promise<SessionEvent[]> {
    const list = this.store(scope.orgId).events.get(sessionPublicId) ?? [];
    return [...list].sort((a, b) => a.seq - b.seq);
  }

  async setAutonomy(scope: WorkspaceScope, input: SetAutonomyInput): Promise<AutonomyPolicy> {
    const s = this.store(scope.orgId);
    const key = input.specKey ?? null;
    let policy = s.policies.find((p) => (p.specKey ?? null) === key);
    if (!policy) {
      policy = { orgId: scope.orgId, level: input.level, caps: input.caps ?? {}, updatedAt: this.now() };
      if (input.specKey !== undefined) policy.specKey = input.specKey;
      s.policies.push(policy);
    } else {
      policy.level = input.level;
      policy.caps = input.caps ?? policy.caps;
      policy.updatedAt = this.now();
    }
    return policy;
  }

  async getAutonomy(scope: WorkspaceScope, specKey?: string): Promise<AutonomyPolicy | null> {
    const key = specKey ?? null;
    return this.store(scope.orgId).policies.find((p) => (p.specKey ?? null) === key) ?? null;
  }

  // ── Provider connections (AG12) ───────────────────────────

  async createConnection(scope: WorkspaceScope, input: CreateConnectionInput): Promise<ProviderConnection> {
    validateConnectionInput(input);
    const s = this.store(scope.orgId);
    if (s.connections.some((c) => c.provider === input.provider && c.name === input.name)) {
      throw new AgentsError("provider_connection_conflict", `${input.provider}/${input.name} already connected`);
    }
    const ts = this.now();
    const conn: ProviderConnection = {
      id: this.id("id_"),
      publicId: this.id("apc_"),
      orgId: scope.orgId,
      provider: input.provider as Provider,
      name: input.name,
      config: input.config ?? {},
      secretRef: input.secretRef,
      status: "unverified",
      createdBy: input.createdBy,
      createdAt: ts,
      updatedAt: ts,
      ...(input.keyHint !== undefined ? { keyHint: input.keyHint } : {}),
    };
    s.connections.push(conn);
    return conn;
  }

  async listConnections(scope: WorkspaceScope, provider?: Provider): Promise<ProviderConnection[]> {
    let rows = this.store(scope.orgId).connections;
    if (provider) rows = rows.filter((c) => c.provider === provider);
    return [...rows].sort((a, b) => (a.provider + a.name).localeCompare(b.provider + b.name));
  }

  async getConnection(scope: WorkspaceScope, publicId: string): Promise<ProviderConnection | null> {
    return this.store(scope.orgId).connections.find((c) => c.publicId === publicId) ?? null;
  }

  async setConnectionStatus(scope: WorkspaceScope, input: SetConnectionStatusInput): Promise<ProviderConnection> {
    const conn = await this.getConnection(scope, input.publicId);
    if (!conn) {
      throw new AgentsError("provider_connection_not_found", `connection ${input.publicId} not found`);
    }
    conn.status = input.status;
    if (input.statusReason !== undefined) conn.statusReason = input.statusReason;
    else delete conn.statusReason;
    if (input.status === "verified") conn.lastVerifiedAt = this.now();
    conn.updatedAt = this.now();
    return conn;
  }

  async deleteConnection(scope: WorkspaceScope, publicId: string): Promise<boolean> {
    const s = this.store(scope.orgId);
    const before = s.connections.length;
    s.connections = s.connections.filter((c) => c.publicId !== publicId);
    return s.connections.length < before;
  }
}
