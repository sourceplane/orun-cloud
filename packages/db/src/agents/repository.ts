// Postgres AgentsRepository over the 650_agents_foundation schema.
//
// Same discipline as MemoryAgentsRepository: transitions guarded by the model
// table, the event vocabulary closed, event dedupe on (session, seq), no
// work-status surface. Dormant until AG6 wires the worker.

import type { TransactionalSqlExecutor } from "../hyperdrive/executor.js";
import {
  AgentsError,
  canTransition,
  isTerminal,
  validateConnectionInput,
  validateProfileInput,
  validateSessionEvent,
  type AgentProfile,
  type AgentSession,
  type AutonomyLevel,
  type AutonomyPolicy,
  type ConnectionStatus,
  type Provider,
  type ProviderConnection,
  type RunKind,
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

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function optIso(value: unknown): string | undefined {
  return value == null ? undefined : toIso(value);
}

function optStr(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

function newPublicId(prefix: string): string {
  // Short random public id. crypto.randomUUID is available in Workers + Node.
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function mapProfile(row: Row): AgentProfile {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    orgId: String(row.org_id),
    name: String(row.name),
    principalId: String(row.principal_id),
    owner: String(row.owner),
    agentType: String(row.agent_type),
    harness: String(row.harness),
    model: String(row.model),
    autonomyDefault: String(row.autonomy_default) as AutonomyLevel,
    capability: parseJson<Record<string, unknown>>(row.capability, {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapSession(row: Row): AgentSession {
  const s: AgentSession = {
    id: String(row.id),
    publicId: String(row.public_id),
    orgId: String(row.org_id),
    profileId: String(row.profile_id),
    runKind: String(row.run_kind) as RunKind,
    state: String(row.state) as SessionState,
    sandbox: parseJson<Record<string, unknown>>(row.sandbox, {}),
    spawnedBy: String(row.spawned_by),
    createdAt: toIso(row.created_at),
  };
  const workRef = optStr(row.work_ref);
  if (workRef !== undefined) s.workRef = workRef;
  const taskKey = optStr(row.task_key);
  if (taskKey !== undefined) s.taskKey = taskKey;
  const prUrl = optStr(row.pr_url);
  if (prUrl !== undefined) s.prUrl = prUrl;
  const snapshotId = optStr(row.snapshot_id);
  if (snapshotId !== undefined) s.snapshotId = snapshotId;
  const lease = optIso(row.lease_expires_at);
  if (lease !== undefined) s.leaseExpiresAt = lease;
  const started = optIso(row.started_at);
  if (started !== undefined) s.startedAt = started;
  const ended = optIso(row.ended_at);
  if (ended !== undefined) s.endedAt = ended;
  return s;
}


function mapConnection(row: Row): ProviderConnection {
  const c: ProviderConnection = {
    id: String(row.id),
    publicId: String(row.public_id),
    orgId: String(row.org_id),
    provider: String(row.provider) as Provider,
    name: String(row.name),
    config: parseJson<Record<string, unknown>>(row.config, {}),
    secretRef: String(row.secret_ref),
    status: String(row.status) as ConnectionStatus,
    createdBy: String(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  const hint = optStr(row.key_hint);
  if (hint !== undefined) c.keyHint = hint;
  const verified = optIso(row.last_verified_at);
  if (verified !== undefined) c.lastVerifiedAt = verified;
  const reason = optStr(row.status_reason);
  if (reason !== undefined) c.statusReason = reason;
  return c;
}

export function createAgentsRepository(sql: TransactionalSqlExecutor): AgentsRepository {
  return {
    async createProfile(scope: WorkspaceScope, input: CreateProfileInput): Promise<AgentProfile> {
      validateProfileInput(input);
      const res = await sql.execute(
        `INSERT INTO agents.agent_profiles
           (public_id, org_id, name, principal_id, owner, agent_type, harness, model, autonomy_default, capability)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         RETURNING *`,
        [
          newPublicId("agp_"),
          scope.orgId,
          input.name,
          input.principalId,
          input.owner,
          input.agentType,
          input.harness,
          input.model,
          input.autonomyDefault ?? "assist",
          JSON.stringify(input.capability ?? {}),
        ],
      );
      return mapProfile(res.rows[0] as Row);
    },

    async getProfile(scope: WorkspaceScope, name: string): Promise<AgentProfile | null> {
      const res = await sql.execute(
        `SELECT * FROM agents.agent_profiles WHERE org_id = $1 AND name = $2`,
        [scope.orgId, name],
      );
      return res.rows[0] ? mapProfile(res.rows[0] as Row) : null;
    },

    async listProfiles(scope: WorkspaceScope): Promise<AgentProfile[]> {
      const res = await sql.execute(
        `SELECT * FROM agents.agent_profiles WHERE org_id = $1 ORDER BY name`,
        [scope.orgId],
      );
      return res.rows.map((r) => mapProfile(r as Row));
    },

    async createSession(scope: WorkspaceScope, input: CreateSessionInput): Promise<AgentSession> {
      return sql.transaction(async (tx) => {
        const p = await tx.execute(
          `SELECT id FROM agents.agent_profiles WHERE org_id = $1 AND (id::text = $2 OR public_id = $2)`,
          [scope.orgId, input.profileId],
        );
        if (!p.rows[0]) {
          throw new AgentsError("agent_profile_not_found", `profile ${input.profileId} not found`);
        }
        const profileId = String((p.rows[0] as Row).id);
        const res = await tx.execute(
          `INSERT INTO agents.agent_sessions
             (public_id, org_id, profile_id, run_kind, state, spawned_by, work_ref, task_key)
           VALUES ($1,$2,$3,$4,'requested',$5,$6,$7)
           RETURNING *`,
          [
            newPublicId("as_"),
            scope.orgId,
            profileId,
            input.runKind,
            input.spawnedBy,
            input.workRef ?? null,
            input.taskKey ?? null,
          ],
        );
        return mapSession(res.rows[0] as Row);
      });
    },

    async getSession(scope: WorkspaceScope, publicId: string): Promise<AgentSession | null> {
      const res = await sql.execute(
        `SELECT * FROM agents.agent_sessions WHERE org_id = $1 AND public_id = $2`,
        [scope.orgId, publicId],
      );
      return res.rows[0] ? mapSession(res.rows[0] as Row) : null;
    },

    async getSessionProfile(scope: WorkspaceScope, sessionPublicId: string): Promise<AgentProfile | null> {
      const res = await sql.execute(
        `SELECT p.* FROM agents.agent_profiles p
           JOIN agents.agent_sessions s ON s.profile_id = p.id
         WHERE s.org_id = $1 AND s.public_id = $2`,
        [scope.orgId, sessionPublicId],
      );
      return res.rows[0] ? mapProfile(res.rows[0] as Row) : null;
    },

    async touchSessionLease(
      scope: WorkspaceScope,
      sessionPublicId: string,
      leaseExpiresAt: string,
    ): Promise<AgentSession> {
      // Refuses terminal states in the WHERE — a dead session's lease never
      // revives (the sweep's over-destroy posture stays sound).
      const res = await sql.execute(
        `UPDATE agents.agent_sessions SET lease_expires_at = $3
         WHERE org_id = $1 AND public_id = $2
           AND state NOT IN ('completed','failed','canceled','expired')
         RETURNING *`,
        [scope.orgId, sessionPublicId, leaseExpiresAt],
      );
      if (!res.rows[0]) {
        const exists = await sql.execute(
          `SELECT state FROM agents.agent_sessions WHERE org_id = $1 AND public_id = $2`,
          [scope.orgId, sessionPublicId],
        );
        if (!exists.rows[0]) {
          throw new AgentsError("agent_session_not_found", `session ${sessionPublicId} not found`);
        }
        throw new AgentsError(
          "agent_session_bad_transition",
          `session is ${String((exists.rows[0] as Row).state)}; lease cannot revive it`,
        );
      }
      return mapSession(res.rows[0] as Row);
    },

    async listLapsedSessions(input: ListLapsedSessionsInput): Promise<AgentSession[]> {
      // Deliberately CROSS-ORG: the sweep reclaims the whole fleet.
      const res = await sql.execute(
        `SELECT * FROM agents.agent_sessions
         WHERE ((state IN ('running','awaiting_approval'))
                AND lease_expires_at IS NOT NULL AND lease_expires_at < $1)
            OR (state = 'provisioning' AND created_at < $2)
         ORDER BY created_at
         LIMIT $3`,
        [input.leaseCutoff, input.provisioningCutoff, input.limit],
      );
      return res.rows.map((r) => mapSession(r as Row));
    },

    async listSessions(scope: WorkspaceScope, filter?: { state?: SessionState }): Promise<AgentSession[]> {
      const res = filter?.state
        ? await sql.execute(
            `SELECT * FROM agents.agent_sessions WHERE org_id = $1 AND state = $2 ORDER BY created_at DESC`,
            [scope.orgId, filter.state],
          )
        : await sql.execute(
            `SELECT * FROM agents.agent_sessions WHERE org_id = $1 ORDER BY created_at DESC`,
            [scope.orgId],
          );
      return res.rows.map((r) => mapSession(r as Row));
    },

    async advanceSession(scope: WorkspaceScope, input: AdvanceSessionInput): Promise<AgentSession> {
      return sql.transaction(async (tx) => {
        const cur = await tx.execute(
          `SELECT * FROM agents.agent_sessions WHERE org_id = $1 AND public_id = $2 FOR UPDATE`,
          [scope.orgId, input.publicId],
        );
        if (!cur.rows[0]) {
          throw new AgentsError("agent_session_not_found", `session ${input.publicId} not found`);
        }
        const from = String((cur.rows[0] as Row).state) as SessionState;
        if (!canTransition(from, input.to)) {
          throw new AgentsError("agent_session_bad_transition", `${from} → ${input.to} not allowed`);
        }
        const setStarted = input.to === "running" && (cur.rows[0] as Row).started_at == null;
        const res = await tx.execute(
          `UPDATE agents.agent_sessions SET
             state = $3,
             pr_url = COALESCE($4, pr_url),
             snapshot_id = COALESCE($5, snapshot_id),
             lease_expires_at = COALESCE($6, lease_expires_at),
             sandbox = COALESCE($7::jsonb, sandbox),
             started_at = CASE WHEN $8 THEN now() ELSE started_at END,
             ended_at = CASE WHEN $9 THEN now() ELSE ended_at END
           WHERE org_id = $1 AND public_id = $2
           RETURNING *`,
          [
            scope.orgId,
            input.publicId,
            input.to,
            input.prUrl ?? null,
            input.snapshotId ?? null,
            input.leaseExpiresAt ?? null,
            input.sandbox ? JSON.stringify(input.sandbox) : null,
            setStarted,
            isTerminal(input.to),
          ],
        );
        return mapSession(res.rows[0] as Row);
      });
    },

    async appendSessionEvent(scope: WorkspaceScope, input: AppendSessionEventInput): Promise<void> {
      validateSessionEvent(input);
      await sql.execute(
        `INSERT INTO agents.session_events (org_id, session_id, seq, kind, payload, ref)
         SELECT $1, s.id, $3, $4, $5::jsonb, $6
           FROM agents.agent_sessions s
          WHERE s.org_id = $1 AND s.public_id = $2
         ON CONFLICT (session_id, seq) DO NOTHING`,
        [
          scope.orgId,
          input.sessionPublicId,
          input.seq,
          input.kind,
          JSON.stringify(input.payload ?? {}),
          input.ref ?? null,
        ],
      );
    },

    async listSessionEvents(scope: WorkspaceScope, sessionPublicId: string): Promise<SessionEvent[]> {
      const res = await sql.execute(
        `SELECT e.seq, e.kind, e.payload, e.ref, e.at
           FROM agents.session_events e
           JOIN agents.agent_sessions s ON s.id = e.session_id
          WHERE s.org_id = $1 AND s.public_id = $2
          ORDER BY e.seq`,
        [scope.orgId, sessionPublicId],
      );
      return res.rows.map((r0) => {
        const r = r0 as Row;
        const ev: SessionEvent = {
          seq: Number(r.seq),
          kind: String(r.kind) as SessionEvent["kind"],
          payload: parseJson<Record<string, unknown>>(r.payload, {}),
          at: toIso(r.at),
        };
        const ref = optStr(r.ref);
        if (ref !== undefined) ev.ref = ref;
        return ev;
      });
    },

    async setAutonomy(scope: WorkspaceScope, input: SetAutonomyInput): Promise<AutonomyPolicy> {
      const res = await sql.execute(
        `INSERT INTO agents.autonomy_policies (org_id, spec_key, level, caps)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (org_id, spec_key) DO UPDATE
           SET level = EXCLUDED.level, caps = EXCLUDED.caps, updated_at = now()
         RETURNING *`,
        [scope.orgId, input.specKey ?? null, input.level, JSON.stringify(input.caps ?? {})],
      );
      const r = res.rows[0] as Row;
      const policy: AutonomyPolicy = {
        orgId: String(r.org_id),
        level: String(r.level) as AutonomyLevel,
        caps: parseJson<Record<string, unknown>>(r.caps, {}),
        updatedAt: toIso(r.updated_at),
      };
      const sk = optStr(r.spec_key);
      if (sk !== undefined) policy.specKey = sk;
      return policy;
    },

    async getAutonomy(scope: WorkspaceScope, specKey?: string): Promise<AutonomyPolicy | null> {
      const res = await sql.execute(
        `SELECT * FROM agents.autonomy_policies
          WHERE org_id = $1 AND spec_key IS NOT DISTINCT FROM $2`,
        [scope.orgId, specKey ?? null],
      );
      if (!res.rows[0]) return null;
      const r = res.rows[0] as Row;
      const policy: AutonomyPolicy = {
        orgId: String(r.org_id),
        level: String(r.level) as AutonomyLevel,
        caps: parseJson<Record<string, unknown>>(r.caps, {}),
        updatedAt: toIso(r.updated_at),
      };
      const sk = optStr(r.spec_key);
      if (sk !== undefined) policy.specKey = sk;
      return policy;
    },

    // ── Provider connections (AG12) ───────────────────────────

    async createConnection(scope: WorkspaceScope, input: CreateConnectionInput): Promise<ProviderConnection> {
      validateConnectionInput(input);
      const existing = await sql.execute(
        `SELECT 1 FROM agents.provider_connections WHERE org_id = $1 AND provider = $2 AND name = $3`,
        [scope.orgId, input.provider, input.name],
      );
      if (existing.rows[0]) {
        throw new AgentsError("provider_connection_conflict", `${input.provider}/${input.name} already connected`);
      }
      const res = await sql.execute(
        `INSERT INTO agents.provider_connections
           (public_id, org_id, provider, name, config, secret_ref, key_hint, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
         RETURNING *`,
        [
          newPublicId("apc_"),
          scope.orgId,
          input.provider,
          input.name,
          JSON.stringify(input.config ?? {}),
          input.secretRef,
          input.keyHint ?? null,
          input.createdBy,
        ],
      );
      return mapConnection(res.rows[0] as Row);
    },

    async listConnections(scope: WorkspaceScope, provider?: Provider): Promise<ProviderConnection[]> {
      const res = provider
        ? await sql.execute(
            `SELECT * FROM agents.provider_connections WHERE org_id = $1 AND provider = $2 ORDER BY provider, name`,
            [scope.orgId, provider],
          )
        : await sql.execute(
            `SELECT * FROM agents.provider_connections WHERE org_id = $1 ORDER BY provider, name`,
            [scope.orgId],
          );
      return res.rows.map((r) => mapConnection(r as Row));
    },

    async getConnection(scope: WorkspaceScope, publicId: string): Promise<ProviderConnection | null> {
      const res = await sql.execute(
        `SELECT * FROM agents.provider_connections WHERE org_id = $1 AND public_id = $2`,
        [scope.orgId, publicId],
      );
      return res.rows[0] ? mapConnection(res.rows[0] as Row) : null;
    },

    async setConnectionStatus(scope: WorkspaceScope, input: SetConnectionStatusInput): Promise<ProviderConnection> {
      const res = await sql.execute(
        `UPDATE agents.provider_connections SET
           status = $3,
           status_reason = $4,
           last_verified_at = CASE WHEN $3 = 'verified' THEN now() ELSE last_verified_at END,
           updated_at = now()
         WHERE org_id = $1 AND public_id = $2
         RETURNING *`,
        [scope.orgId, input.publicId, input.status, input.statusReason ?? null],
      );
      if (!res.rows[0]) {
        throw new AgentsError("provider_connection_not_found", `connection ${input.publicId} not found`);
      }
      return mapConnection(res.rows[0] as Row);
    },

    async deleteConnection(scope: WorkspaceScope, publicId: string): Promise<boolean> {
      const res = await sql.execute(
        `DELETE FROM agents.provider_connections WHERE org_id = $1 AND public_id = $2 RETURNING id`,
        [scope.orgId, publicId],
      );
      return !!res.rows[0];
    },

  };
}
