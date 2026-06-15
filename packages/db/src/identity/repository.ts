import type { SqlExecutor } from "../hyperdrive/executor.js";
import type {
  ApiKey,
  ApiKeyPagedResult,
  ApiKeyPageQueryParams,
  AuthIdentity,
  CliLoginGrant,
  CliSessionByRefresh,
  CreateApiKeyInput,
  CreateAuthIdentityInput,
  CreateCliLoginGrantInput,
  CreateCliSessionInput,
  CreateLoginChallengeInput,
  CreateSecurityEventInput,
  CreateServicePrincipalInput,
  CreateSessionInput,
  CreateUserInput,
  IdentityRepository,
  IdentityResult,
  LoginChallenge,
  RotateCliSessionInput,
  SecurityEvent,
  SecurityEventPagedResult,
  SecurityEventPageQueryParams,
  ServicePrincipal,
  Session,
  UpdateUserProfileInput,
  User,
} from "./types.js";

function mapUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    emailLower: row.email_lower as string,
    displayName: (row.display_name as string) ?? null,
    lastOrgSlug: (row.last_org_slug as string) ?? null,
    status: row.status as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapAuthIdentity(row: Record<string, unknown>): AuthIdentity {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    provider: row.provider as string,
    subject: row.subject as string,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapLoginChallenge(row: Record<string, unknown>): LoginChallenge {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    method: row.method as string,
    expiresAt: new Date(row.expires_at as string),
    consumedAt: row.consumed_at ? new Date(row.consumed_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

function mapSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    expiresAt: new Date(row.expires_at as string),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
    createdAt: new Date(row.created_at as string),
    lastSeenAt: new Date(row.last_seen_at as string),
    // OP1 CLI-session columns. Web sessions (and pre-230 rows read back via the
    // column defaults) have kind 'web', generation 0, and null family/refresh.
    kind: ((row.kind as string) ?? "web") as Session["kind"],
    refreshFamilyId: (row.refresh_family_id as string) ?? null,
    refreshGeneration: row.refresh_generation != null ? Number(row.refresh_generation) : 0,
    replacedBy: (row.replaced_by as string) ?? null,
    revokedReason: (row.revoked_reason as string) ?? null,
    clientHost: (row.client_host as string) ?? null,
    refreshExpiresAt: row.refresh_expires_at ? new Date(row.refresh_expires_at as string) : null,
  };
}

function mapCliLoginGrant(row: Record<string, unknown>): CliLoginGrant {
  return {
    id: row.id as string,
    flow: row.flow as CliLoginGrant["flow"],
    status: row.status as CliLoginGrant["status"],
    clientHost: (row.client_host as string) ?? null,
    approvedBy: (row.approved_by as string) ?? null,
    approvedAt: row.approved_at ? new Date(row.approved_at as string) : null,
    sessionId: (row.session_id as string) ?? null,
    redeemedAt: row.redeemed_at ? new Date(row.redeemed_at as string) : null,
    expiresAt: new Date(row.expires_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapSecurityEvent(row: Record<string, unknown>): SecurityEvent {
  return {
    id: row.id as string,
    eventType: row.event_type as string,
    outcome: row.outcome as string,
    userId: (row.user_id as string) ?? null,
    sessionId: (row.session_id as string) ?? null,
    challengeId: (row.challenge_id as string) ?? null,
    requestId: (row.request_id as string) ?? null,
    correlationId: (row.correlation_id as string) ?? null,
    ip: (row.ip as string) ?? null,
    userAgent: (row.user_agent as string) ?? null,
    occurredAt: new Date(row.occurred_at as string),
    createdAt: new Date(row.created_at as string),
    metadata: (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata ?? {}) as Record<string, unknown>,
    redactPaths: (typeof row.redact_paths === "string" ? JSON.parse(row.redact_paths) : row.redact_paths ?? []) as string[],
  };
}

function mapServicePrincipal(row: Record<string, unknown>): ServicePrincipal {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    displayName: row.display_name as string,
    description: (row.description as string) ?? null,
    status: row.status as string,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapApiKey(row: Record<string, unknown>): ApiKey {
  return {
    id: row.id as string,
    servicePrincipalId: row.service_principal_id as string,
    orgId: row.org_id as string,
    keyPrefix: row.key_prefix as string,
    label: (row.label as string) ?? "",
    status: row.status as string,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
    revokedBy: (row.revoked_by as string) ?? null,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function safeError(message: string, cause?: unknown): IdentityResult<never> {
  // Surface the underlying DB error to the Worker log (wrangler tail / dashboard)
  // so a generic `internal_error` API response is diagnosable. The message
  // returned to the caller stays generic — no internal detail leaks to clients.
  if (cause !== undefined) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(
      JSON.stringify({ level: "error", scope: "identity.repository", message, detail })
    );
  }
  return { ok: false, error: { kind: "internal", message } };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

// Column is an internal allowlist constant (never user input) — safe to inline.
async function getGrantBy(
  executor: SqlExecutor,
  column: "id" | "cli_code_hash" | "device_code_hash" | "user_code_hash",
  value: string,
): Promise<IdentityResult<CliLoginGrant>> {
  try {
    const result = await executor.execute<Record<string, unknown>>(
      `SELECT * FROM identity.cli_login_grants WHERE ${column} = $1`,
      [value],
    );
    if (result.rowCount === 0) {
      return { ok: false, error: { kind: "not_found" } };
    }
    return { ok: true, value: mapCliLoginGrant(result.rows[0]!) };
  } catch {
    return { ok: false, error: { kind: "internal", message: "Failed to get CLI login grant" } };
  }
}

export function createIdentityRepository(executor: SqlExecutor): IdentityRepository {
  return {
    async createUser(input: CreateUserInput): Promise<IdentityResult<User>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO identity.users (id, email, email_lower, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.email, input.emailLower, input.displayName ?? null, input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "user" } };
        }
        return { ok: true, value: mapUser(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "user" } };
        }
        return safeError("Failed to create user");
      }
    },

    async getUserById(id: string): Promise<IdentityResult<User>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM identity.users WHERE id = $1`,
          [id],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapUser(result.rows[0]!) };
      } catch {
        return safeError("Failed to get user");
      }
    },

    async getUserByEmail(emailLower: string): Promise<IdentityResult<User>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM identity.users WHERE email_lower = $1`,
          [emailLower],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapUser(result.rows[0]!) };
      } catch {
        return safeError("Failed to get user by email");
      }
    },

    async updateUserProfile(userId: string, input: UpdateUserProfileInput): Promise<IdentityResult<User>> {
      try {
        // Partial update: only set the columns the caller provided. `updated_at`
        // is always bumped. $1 = id, $2 = updated_at, then provided fields.
        const sets: string[] = ["updated_at = $2"];
        const params: unknown[] = [userId, input.updatedAt.toISOString()];
        if (input.displayName !== undefined) {
          params.push(input.displayName);
          sets.push(`display_name = $${params.length}`);
        }
        if (input.lastOrgSlug !== undefined) {
          params.push(input.lastOrgSlug);
          sets.push(`last_org_slug = $${params.length}`);
        }
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE identity.users SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
          params,
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapUser(result.rows[0]!) };
      } catch {
        return safeError("Failed to update user profile");
      }
    },

    async createAuthIdentity(input: CreateAuthIdentityInput): Promise<IdentityResult<AuthIdentity>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO identity.auth_identities (id, user_id, provider, subject, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.userId, input.provider, input.subject, JSON.stringify(input.metadata ?? {}), input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "auth_identity" } };
        }
        return { ok: true, value: mapAuthIdentity(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "auth_identity" } };
        }
        return safeError("Failed to create auth identity");
      }
    },

    async getAuthIdentityByProviderSubject(provider: string, subject: string): Promise<IdentityResult<AuthIdentity>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM identity.auth_identities WHERE provider = $1 AND subject = $2`,
          [provider, subject],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapAuthIdentity(result.rows[0]!) };
      } catch {
        return safeError("Failed to get auth identity");
      }
    },

    async createLoginChallenge(input: CreateLoginChallengeInput): Promise<IdentityResult<LoginChallenge>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO identity.login_challenges (id, user_id, method, code_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.userId, input.method, input.codeHash, input.expiresAt.toISOString(), input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "login_challenge" } };
        }
        return { ok: true, value: mapLoginChallenge(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "login_challenge" } };
        }
        return safeError("Failed to create login challenge");
      }
    },

    async getLoginChallengeById(id: string): Promise<IdentityResult<LoginChallenge>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, user_id, method, expires_at, consumed_at, created_at FROM identity.login_challenges WHERE id = $1`,
          [id],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const challenge = mapLoginChallenge(result.rows[0]!);
        if (challenge.consumedAt !== null) {
          return { ok: false, error: { kind: "already_consumed" } };
        }
        if (challenge.expiresAt < new Date()) {
          return { ok: false, error: { kind: "expired" } };
        }
        return { ok: true, value: challenge };
      } catch {
        return safeError("Failed to get login challenge");
      }
    },

    async consumeLoginChallenge(id: string, codeHash: string, consumedAt: Date): Promise<IdentityResult<LoginChallenge>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE identity.login_challenges
           SET consumed_at = $3
           WHERE id = $1 AND code_hash = $2 AND consumed_at IS NULL
           RETURNING *`,
          [id, codeHash, consumedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "already_consumed" } };
        }
        return { ok: true, value: mapLoginChallenge(result.rows[0]!) };
      } catch {
        return safeError("Failed to consume login challenge");
      }
    },

    async createSession(input: CreateSessionInput): Promise<IdentityResult<Session>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO identity.sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $5)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.userId, input.tokenHash, input.expiresAt.toISOString(), input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "session" } };
        }
        return { ok: true, value: mapSession(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "session" } };
        }
        return safeError("Failed to create session");
      }
    },

    async getSessionByTokenHash(tokenHash: string): Promise<IdentityResult<Session>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, user_id, expires_at, revoked_at, created_at, last_seen_at FROM identity.sessions WHERE token_hash = $1 AND revoked_at IS NULL`,
          [tokenHash],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const session = mapSession(result.rows[0]!);
        if (session.expiresAt < new Date()) {
          return { ok: false, error: { kind: "expired" } };
        }
        return { ok: true, value: session };
      } catch {
        return safeError("Failed to get session");
      }
    },

    async getSessionWithUserByTokenHash(
      tokenHash: string,
    ): Promise<IdentityResult<{ session: Session; user: User }>> {
      try {
        // PERF12d: fold the session lookup and its user fetch into one JOIN so a
        // bearer-cache miss costs one DB round-trip, not two. Session columns are
        // aliased (sessions and users both have `id`/`created_at`); `u.*` feeds
        // mapUser, the aliased columns are split back to mapSession. Same filters
        // and not_found/expired semantics as getSessionByTokenHash.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT
             s.id AS session_id,
             s.user_id AS session_user_id,
             s.expires_at AS session_expires_at,
             s.revoked_at AS session_revoked_at,
             s.created_at AS session_created_at,
             s.last_seen_at AS session_last_seen_at,
             u.*
           FROM identity.sessions s
           JOIN identity.users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
          [tokenHash],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const row = result.rows[0]!;
        const session = mapSession({
          id: row.session_id,
          user_id: row.session_user_id,
          expires_at: row.session_expires_at,
          revoked_at: row.session_revoked_at,
          created_at: row.session_created_at,
          last_seen_at: row.session_last_seen_at,
        });
        if (session.expiresAt < new Date()) {
          return { ok: false, error: { kind: "expired" } };
        }
        return { ok: true, value: { session, user: mapUser(row) } };
      } catch {
        return safeError("Failed to get session");
      }
    },

    async revokeSession(id: string, revokedAt: Date): Promise<IdentityResult<Session>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE identity.sessions
           SET revoked_at = $2
           WHERE id = $1 AND revoked_at IS NULL
           RETURNING *`,
          [id, revokedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSession(result.rows[0]!) };
      } catch {
        return safeError("Failed to revoke session");
      }
    },

    // --- CLI sessions (rotating refresh + token family) ---

    async createCliSession(input: CreateCliSessionInput): Promise<IdentityResult<Session>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO identity.sessions
             (id, user_id, token_hash, kind, refresh_token_hash, refresh_family_id,
              refresh_generation, expires_at, refresh_expires_at, client_host,
              created_at, last_seen_at)
           VALUES ($1, $2, $3, 'cli', $4, $5, $6, $7, $8, $9, $10, $10)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.userId,
            input.tokenHash,
            input.refreshTokenHash,
            input.refreshFamilyId,
            input.refreshGeneration,
            input.expiresAt.toISOString(),
            input.refreshExpiresAt.toISOString(),
            input.clientHost ?? null,
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "session" } };
        }
        return { ok: true, value: mapSession(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "session" } };
        }
        return safeError("Failed to create CLI session", err);
      }
    },

    async getCliSessionByRefreshHash(refreshTokenHash: string): Promise<IdentityResult<CliSessionByRefresh>> {
      try {
        // Every generation keeps its refresh_token_hash for reuse detection: the
        // caller inspects `revokedAt`/`replacedBy` to tell the LIVE token from an
        // already-rotated one (presenting a rotated hash ⇒ reuse ⇒ family revoke).
        // Hashes are globally unique (distinct random token per generation), so
        // this lookup is unambiguous.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT
             s.id AS session_id,
             s.user_id AS session_user_id,
             s.expires_at AS session_expires_at,
             s.revoked_at AS session_revoked_at,
             s.created_at AS session_created_at,
             s.last_seen_at AS session_last_seen_at,
             s.kind AS session_kind,
             s.refresh_token_hash AS session_refresh_token_hash,
             s.refresh_family_id AS session_refresh_family_id,
             s.refresh_generation AS session_refresh_generation,
             s.replaced_by AS session_replaced_by,
             s.revoked_reason AS session_revoked_reason,
             s.client_host AS session_client_host,
             s.refresh_expires_at AS session_refresh_expires_at,
             -- Family origin (generation 1's created_at), carried across
             -- rotations to enforce the absolute session-lifetime cap.
             (SELECT MIN(f.created_at) FROM identity.sessions f
              WHERE f.refresh_family_id = s.refresh_family_id) AS family_started_at,
             u.*
           FROM identity.sessions s
           JOIN identity.users u ON u.id = s.user_id
           WHERE s.refresh_token_hash = $1`,
          [refreshTokenHash],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const row = result.rows[0]!;
        const session = mapSession({
          id: row.session_id,
          user_id: row.session_user_id,
          expires_at: row.session_expires_at,
          revoked_at: row.session_revoked_at,
          created_at: row.session_created_at,
          last_seen_at: row.session_last_seen_at,
          kind: row.session_kind,
          refresh_token_hash: row.session_refresh_token_hash,
          refresh_family_id: row.session_refresh_family_id,
          refresh_generation: row.session_refresh_generation,
          replaced_by: row.session_replaced_by,
          revoked_reason: row.session_revoked_reason,
          client_host: row.session_client_host,
          refresh_expires_at: row.session_refresh_expires_at,
        });
        const familyStartedAt = row.family_started_at
          ? new Date(row.family_started_at as string)
          : session.createdAt;
        return { ok: true, value: { session, user: mapUser(row), familyStartedAt } };
      } catch {
        return safeError("Failed to resolve CLI session");
      }
    },

    async getSessionById(id: string): Promise<IdentityResult<Session>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM identity.sessions WHERE id = $1`,
          [id],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSession(result.rows[0]!) };
      } catch {
        return safeError("Failed to get session");
      }
    },

    async rotateCliSession(input: RotateCliSessionInput): Promise<IdentityResult<Session>> {
      try {
        // Single-use rotation: mark the current row replaced + revoked, but KEEP
        // its refresh_token_hash so a later reuse of that token is detectable
        // (the refresh path sees replaced_by/revoked_at set ⇒ reuse ⇒ family
        // revoke). The guarded WHERE (replaced_by IS NULL AND revoked_at IS NULL)
        // makes a concurrent double-rotate fail closed (rowCount 0 → conflict).
        const updated = await executor.execute<Record<string, unknown>>(
          `UPDATE identity.sessions
           SET replaced_by = $2,
               revoked_at = $3,
               revoked_reason = 'superseded'
           WHERE id = $1 AND replaced_by IS NULL AND revoked_at IS NULL`,
          [input.currentSessionId, input.newSessionId, input.rotatedAt.toISOString()],
        );
        if (updated.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "session" } };
        }

        const inserted = await executor.execute<Record<string, unknown>>(
          `INSERT INTO identity.sessions
             (id, user_id, token_hash, kind, refresh_token_hash, refresh_family_id,
              refresh_generation, expires_at, refresh_expires_at, client_host,
              created_at, last_seen_at)
           VALUES ($1, $2, $3, 'cli', $4, $5, $6, $7, $8, $9, $10, $10)
           RETURNING *`,
          [
            input.newSessionId,
            input.userId,
            input.newTokenHash,
            input.newRefreshTokenHash,
            input.refreshFamilyId,
            input.newRefreshGeneration,
            input.expiresAt.toISOString(),
            input.refreshExpiresAt.toISOString(),
            input.clientHost ?? null,
            input.rotatedAt.toISOString(),
          ],
        );
        if (inserted.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "session" } };
        }
        return { ok: true, value: mapSession(inserted.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "session" } };
        }
        return safeError("Failed to rotate CLI session", err);
      }
    },

    async revokeCliFamily(refreshFamilyId: string, reason: string, revokedAt: Date): Promise<IdentityResult<number>> {
      try {
        // Reuse detection / console revoke: revoke every still-live row in the
        // family. Hashes are kept (reuse stays detectable); validity is gated on
        // revoked_at, so a revoked token's refresh is rejected on lookup.
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE identity.sessions
           SET revoked_at = COALESCE(revoked_at, $2),
               revoked_reason = COALESCE(revoked_reason, $3)
           WHERE refresh_family_id = $1 AND revoked_at IS NULL`,
          [refreshFamilyId, revokedAt.toISOString(), reason],
        );
        return { ok: true, value: result.rowCount };
      } catch {
        return safeError("Failed to revoke CLI token family");
      }
    },

    async revokeSessionWithReason(id: string, reason: string, revokedAt: Date): Promise<IdentityResult<Session>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE identity.sessions
           SET revoked_at = $2, revoked_reason = $3
           WHERE id = $1 AND revoked_at IS NULL
           RETURNING *`,
          [id, revokedAt.toISOString(), reason],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSession(result.rows[0]!) };
      } catch {
        return safeError("Failed to revoke session");
      }
    },

    async listCliSessionsByUser(userId: string): Promise<IdentityResult<Session[]>> {
      try {
        // Show one row per family (the live generation, else the latest), newest
        // first — the console lists logical CLI logins, not every rotation.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT DISTINCT ON (COALESCE(refresh_family_id, id)) *
           FROM identity.sessions
           WHERE user_id = $1 AND kind = 'cli'
           ORDER BY COALESCE(refresh_family_id, id),
                    (refresh_token_hash IS NOT NULL) DESC,
                    refresh_generation DESC,
                    created_at DESC`,
          [userId],
        );
        const rows = result.rows.map(mapSession);
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return { ok: true, value: rows };
      } catch {
        return safeError("Failed to list CLI sessions");
      }
    },

    // --- CLI login grants (loopback + device flows) ---

    async createCliLoginGrant(input: CreateCliLoginGrantInput): Promise<IdentityResult<CliLoginGrant>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO identity.cli_login_grants
             (id, flow, cli_code_hash, device_code_hash, user_code_hash, client_host,
              expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.flow,
            input.cliCodeHash ?? null,
            input.deviceCodeHash ?? null,
            input.userCodeHash ?? null,
            input.clientHost ?? null,
            input.expiresAt.toISOString(),
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "cli_login_grant" } };
        }
        return { ok: true, value: mapCliLoginGrant(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "cli_login_grant" } };
        }
        return safeError("Failed to create CLI login grant", err);
      }
    },

    async getCliLoginGrantById(id: string): Promise<IdentityResult<CliLoginGrant>> {
      return getGrantBy(executor, "id", id);
    },
    async getCliLoginGrantByCliCodeHash(cliCodeHash: string): Promise<IdentityResult<CliLoginGrant>> {
      return getGrantBy(executor, "cli_code_hash", cliCodeHash);
    },
    async getCliLoginGrantByDeviceCodeHash(deviceCodeHash: string): Promise<IdentityResult<CliLoginGrant>> {
      return getGrantBy(executor, "device_code_hash", deviceCodeHash);
    },
    async getCliLoginGrantByUserCodeHash(userCodeHash: string): Promise<IdentityResult<CliLoginGrant>> {
      return getGrantBy(executor, "user_code_hash", userCodeHash);
    },

    async approveCliLoginGrant(id: string, approvedBy: string, approvedAt: Date): Promise<IdentityResult<CliLoginGrant>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE identity.cli_login_grants
           SET status = 'approved', approved_by = $2, approved_at = $3, updated_at = $3
           WHERE id = $1 AND status = 'pending'
           RETURNING *`,
          [id, approvedBy, approvedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "cli_login_grant" } };
        }
        return { ok: true, value: mapCliLoginGrant(result.rows[0]!) };
      } catch {
        return safeError("Failed to approve CLI login grant");
      }
    },

    async denyCliLoginGrant(id: string, deniedAt: Date): Promise<IdentityResult<CliLoginGrant>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE identity.cli_login_grants
           SET status = 'denied', updated_at = $2
           WHERE id = $1 AND status IN ('pending', 'approved')
           RETURNING *`,
          [id, deniedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "cli_login_grant" } };
        }
        return { ok: true, value: mapCliLoginGrant(result.rows[0]!) };
      } catch {
        return safeError("Failed to deny CLI login grant");
      }
    },

    async redeemCliLoginGrant(id: string, sessionId: string, redeemedAt: Date): Promise<IdentityResult<CliLoginGrant>> {
      try {
        // Single-use: only an approved, not-yet-redeemed, unexpired grant flips to
        // redeemed. A replayed redeem (status already 'redeemed') matches no row.
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE identity.cli_login_grants
           SET status = 'redeemed', session_id = $2, redeemed_at = $3, updated_at = $3
           WHERE id = $1 AND status = 'approved' AND expires_at > $3
           RETURNING *`,
          [id, sessionId, redeemedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "cli_login_grant" } };
        }
        return { ok: true, value: mapCliLoginGrant(result.rows[0]!) };
      } catch {
        return safeError("Failed to redeem CLI login grant");
      }
    },

    async recordSecurityEvent(input: CreateSecurityEventInput): Promise<IdentityResult<SecurityEvent>> {
      try {
        const occurredAt = input.occurredAt ?? new Date();
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO identity.security_events (id, event_type, outcome, user_id, session_id, challenge_id, request_id, correlation_id, ip, user_agent, occurred_at, metadata, redact_paths)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [
            input.id,
            input.eventType,
            input.outcome,
            input.userId ?? null,
            input.sessionId ?? null,
            input.challengeId ?? null,
            input.requestId ?? null,
            input.correlationId ?? null,
            input.ip ?? null,
            input.userAgent ?? null,
            occurredAt.toISOString(),
            JSON.stringify(input.metadata ?? {}),
            JSON.stringify(input.redactPaths ?? []),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "security_event" } };
        }
        return { ok: true, value: mapSecurityEvent(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "security_event" } };
        }
        return safeError("Failed to record security event");
      }
    },

    async querySecurityEventsByUser(params: SecurityEventPageQueryParams): Promise<IdentityResult<SecurityEventPagedResult>> {
      try {
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];

        if (params.cursor) {
          sql = `SELECT * FROM identity.security_events
           WHERE user_id = $1
             AND (occurred_at, id) < ($3, $4)
           ORDER BY occurred_at DESC, id DESC
           LIMIT $2`;
          values = [params.userId, fetchLimit, params.cursor.occurredAt, params.cursor.id];
        } else {
          sql = `SELECT * FROM identity.security_events
           WHERE user_id = $1
           ORDER BY occurred_at DESC, id DESC
           LIMIT $2`;
          values = [params.userId, fetchLimit];
        }

        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapSecurityEvent);

        let nextCursor: import("./types.js").SecurityEventCursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { occurredAt: last.occurredAt.toISOString(), id: last.id };
        }

        return { ok: true, value: { items: rows, nextCursor } };
      } catch {
        return safeError("Failed to query security events");
      }
    },

    // --- Service Principals ---

    async createServicePrincipal(input: CreateServicePrincipalInput): Promise<IdentityResult<ServicePrincipal>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO identity.service_principals (id, org_id, project_id, display_name, description, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.orgId, input.projectId ?? null, input.displayName, input.description ?? null, input.createdBy, input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "service_principal" } };
        }
        return { ok: true, value: mapServicePrincipal(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "service_principal" } };
        }
        return safeError("Failed to create service principal");
      }
    },

    async getServicePrincipalById(id: string): Promise<IdentityResult<ServicePrincipal>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM identity.service_principals WHERE id = $1 AND status != 'deleted'`,
          [id],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapServicePrincipal(result.rows[0]!) };
      } catch {
        return safeError("Failed to get service principal");
      }
    },

    async listServicePrincipalsByOrg(orgId: string): Promise<IdentityResult<ServicePrincipal[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM identity.service_principals WHERE org_id = $1 AND status != 'deleted' ORDER BY created_at DESC`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapServicePrincipal) };
      } catch {
        return safeError("Failed to list service principals");
      }
    },

    // --- API Keys ---

    async createApiKey(input: CreateApiKeyInput): Promise<IdentityResult<ApiKey>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO identity.api_keys (id, service_principal_id, org_id, key_prefix, key_hash, label, expires_at, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           ON CONFLICT (id) DO NOTHING
           RETURNING id, service_principal_id, org_id, key_prefix, label, status, expires_at, last_used_at, revoked_at, revoked_by, created_by, created_at, updated_at`,
          [input.id, input.servicePrincipalId, input.orgId, input.keyPrefix, input.keyHash, input.label ?? "", input.expiresAt?.toISOString() ?? null, input.createdBy, input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "api_key" } };
        }
        return { ok: true, value: mapApiKey(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "api_key" } };
        }
        return safeError("Failed to create API key");
      }
    },

    async getApiKeyByKeyHash(keyHash: string): Promise<IdentityResult<ApiKey>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, service_principal_id, org_id, key_prefix, label, status, expires_at, last_used_at, revoked_at, revoked_by, created_by, created_at, updated_at
           FROM identity.api_keys WHERE key_hash = $1 AND status = 'active'`,
          [keyHash],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapApiKey(result.rows[0]!) };
      } catch {
        return safeError("Failed to get API key by hash");
      }
    },

    async listApiKeysByOrg(params: ApiKeyPageQueryParams): Promise<IdentityResult<ApiKeyPagedResult>> {
      try {
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];

        if (params.cursor) {
          sql = `SELECT id, service_principal_id, org_id, key_prefix, label, status, expires_at, last_used_at, revoked_at, revoked_by, created_by, created_at, updated_at
           FROM identity.api_keys
           WHERE org_id = $1
             AND (created_at, id) < ($3, $4)
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [params.orgId, fetchLimit, params.cursor.createdAt, params.cursor.id];
        } else {
          sql = `SELECT id, service_principal_id, org_id, key_prefix, label, status, expires_at, last_used_at, revoked_at, revoked_by, created_by, created_at, updated_at
           FROM identity.api_keys
           WHERE org_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [params.orgId, fetchLimit];
        }

        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapApiKey);

        let nextCursor: import("./types.js").ApiKeyCursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }

        return { ok: true, value: { items: rows, nextCursor } };
      } catch {
        return safeError("Failed to list API keys");
      }
    },

    async revokeApiKey(id: string, revokedBy: string, revokedAt: Date): Promise<IdentityResult<ApiKey>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE identity.api_keys
           SET status = 'revoked', revoked_at = $2, revoked_by = $3, updated_at = $2
           WHERE id = $1 AND status = 'active'
           RETURNING id, service_principal_id, org_id, key_prefix, label, status, expires_at, last_used_at, revoked_at, revoked_by, created_by, created_at, updated_at`,
          [id, revokedAt.toISOString(), revokedBy],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapApiKey(result.rows[0]!) };
      } catch {
        return safeError("Failed to revoke API key");
      }
    },
  };
}
