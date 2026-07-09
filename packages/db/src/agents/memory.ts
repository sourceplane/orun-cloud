// In-memory AgentsRepository — the test double and executable contract. Same
// rules as the Postgres impl: transitions guarded, event vocabulary closed,
// dedupe on (session, seq), no work-status surface.

import {
  AgentsError,
  canTransition,
  isTerminal,
  validateProfileInput,
  validateSessionEvent,
  type AgentProfile,
  type AgentSession,
  type AutonomyPolicy,
  type SessionEvent,
  type SessionState,
} from "./model.js";
import type {
  AdvanceSessionInput,
  AgentsRepository,
  AppendSessionEventInput,
  CreateProfileInput,
  CreateSessionInput,
  SetAutonomyInput,
  WorkspaceScope,
} from "./types.js";

interface Stored {
  profiles: AgentProfile[];
  sessions: AgentSession[];
  events: Map<string, SessionEvent[]>; // session publicId → events
  eventSeqs: Map<string, Set<number>>;
  policies: AutonomyPolicy[];
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
      s = { profiles: [], sessions: [], events: new Map(), eventSeqs: new Map(), policies: [] };
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
}
