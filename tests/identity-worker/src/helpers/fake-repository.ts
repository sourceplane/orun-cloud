import type {
  IdentityRepository,
  IdentityResult,
  User,
  AuthIdentity,
  LoginChallenge,
  Session,
  SecurityEvent,
  CreateUserInput,
  CreateAuthIdentityInput,
  CreateLoginChallengeInput,
  CreateSessionInput,
  CreateSecurityEventInput,
  SecurityEventPageQueryParams,
  SecurityEventPagedResult,
  UpdateUserProfileInput,
  ApiKey,
  ServicePrincipal,
  CreateServicePrincipalInput,
  CreateApiKeyInput,
  ApiKeyPageQueryParams,
  ApiKeyPagedResult,
  CliSessionByRefresh,
  CreateCliSessionInput,
  RotateCliSessionInput,
  CliLoginGrant,
  CreateCliLoginGrantInput,
} from "@saas/db/identity";

interface StoredChallenge extends LoginChallenge {
  codeHash: string;
}

interface StoredSession extends Session {
  tokenHash: string;
  refreshTokenHash: string | null;
  // Reuse-grace (R11): successor envelope + deadline stamped on rotation.
  graceSuccessorCiphertext: string | null;
  graceExpiresAt: Date | null;
}

interface StoredGrant extends CliLoginGrant {
  cliCodeHash: string | null;
  deviceCodeHash: string | null;
  userCodeHash: string | null;
}

export function createFakeRepository(): IdentityRepository & {
  _users: Map<string, User>;
  _authIdentities: Map<string, AuthIdentity>;
  _challenges: Map<string, StoredChallenge>;
  _sessions: Map<string, StoredSession>;
  _securityEvents: SecurityEvent[];
  _apiKeys: Map<string, ApiKey & { keyHash: string }>;
  _servicePrincipals: Map<string, ServicePrincipal>;
  _grants: Map<string, StoredGrant>;
} {
  const users = new Map<string, User>();
  const authIdentities = new Map<string, AuthIdentity>();
  const challenges = new Map<string, StoredChallenge>();
  const sessions = new Map<string, StoredSession>();
  const securityEvents: SecurityEvent[] = [];
  const apiKeys = new Map<string, ApiKey & { keyHash: string }>();
  const servicePrincipals = new Map<string, ServicePrincipal>();
  const grants = new Map<string, StoredGrant>();

  const repo: IdentityRepository & {
    _users: Map<string, User>;
    _authIdentities: Map<string, AuthIdentity>;
    _challenges: Map<string, StoredChallenge>;
    _sessions: Map<string, StoredSession>;
    _securityEvents: SecurityEvent[];
    _apiKeys: Map<string, ApiKey & { keyHash: string }>;
    _servicePrincipals: Map<string, ServicePrincipal>;
    _grants: Map<string, StoredGrant>;
  } = {
    _users: users,
    _authIdentities: authIdentities,
    _challenges: challenges,
    _sessions: sessions,
    _securityEvents: securityEvents,
    _apiKeys: apiKeys,
    _servicePrincipals: servicePrincipals,
    _grants: grants,

    async createUser(input: CreateUserInput): Promise<IdentityResult<User>> {
      if (users.has(input.id)) {
        return { ok: false, error: { kind: "conflict", entity: "user" } };
      }
      for (const u of users.values()) {
        if (u.emailLower === input.emailLower) {
          return { ok: false, error: { kind: "conflict", entity: "user" } };
        }
      }
      const user: User = {
        id: input.id,
        email: input.email,
        emailLower: input.emailLower,
        displayName: input.displayName ?? null,
        lastOrgSlug: null,
        status: "active",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      users.set(input.id, user);
      return { ok: true, value: user };
    },

    async getUserById(id: string): Promise<IdentityResult<User>> {
      const user = users.get(id);
      if (!user) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: user };
    },

    async getUserByEmail(emailLower: string): Promise<IdentityResult<User>> {
      for (const u of users.values()) {
        if (u.emailLower === emailLower) return { ok: true, value: u };
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async listUsersByIds(ids: string[]): Promise<IdentityResult<User[]>> {
      const wanted = new Set(ids);
      const found = [...users.values()].filter((u) => wanted.has(u.id) && u.status === "active");
      return { ok: true, value: found };
    },

    async updateUserProfile(userId: string, input: UpdateUserProfileInput): Promise<IdentityResult<User>> {
      const user = users.get(userId);
      if (!user) return { ok: false, error: { kind: "not_found" } };
      if (input.displayName !== undefined) user.displayName = input.displayName;
      if (input.lastOrgSlug !== undefined) user.lastOrgSlug = input.lastOrgSlug;
      user.updatedAt = input.updatedAt;
      return { ok: true, value: user };
    },

    async createAuthIdentity(input: CreateAuthIdentityInput): Promise<IdentityResult<AuthIdentity>> {
      const identity: AuthIdentity = {
        id: input.id,
        userId: input.userId,
        provider: input.provider,
        subject: input.subject,
        metadata: input.metadata ?? {},
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      authIdentities.set(input.id, identity);
      return { ok: true, value: identity };
    },

    async getAuthIdentityByProviderSubject(provider: string, subject: string): Promise<IdentityResult<AuthIdentity>> {
      for (const ai of authIdentities.values()) {
        if (ai.provider === provider && ai.subject === subject) {
          return { ok: true, value: ai };
        }
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async createLoginChallenge(input: CreateLoginChallengeInput): Promise<IdentityResult<LoginChallenge>> {
      const challenge: StoredChallenge = {
        id: input.id,
        userId: input.userId,
        method: input.method,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: input.createdAt,
        codeHash: input.codeHash,
      };
      challenges.set(input.id, challenge);
      return { ok: true, value: challenge };
    },

    async getLoginChallengeById(id: string): Promise<IdentityResult<LoginChallenge>> {
      const c = challenges.get(id);
      if (!c) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: c };
    },

    async consumeLoginChallenge(id: string, codeHash: string, consumedAt: Date): Promise<IdentityResult<LoginChallenge>> {
      const c = challenges.get(id);
      if (!c) return { ok: false, error: { kind: "not_found" } };
      if (c.consumedAt !== null) return { ok: false, error: { kind: "already_consumed" } };
      if (c.expiresAt.getTime() <= consumedAt.getTime()) return { ok: false, error: { kind: "expired" } };
      if (c.codeHash !== codeHash) return { ok: false, error: { kind: "not_found" } };
      c.consumedAt = consumedAt;
      return { ok: true, value: c };
    },

    async createSession(input: CreateSessionInput): Promise<IdentityResult<Session>> {
      const session: StoredSession = {
        id: input.id,
        userId: input.userId,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: input.createdAt,
        lastSeenAt: input.createdAt,
        tokenHash: input.tokenHash,
        kind: "web",
        refreshTokenHash: null,
        refreshFamilyId: null,
        refreshGeneration: 0,
        replacedBy: null,
        revokedReason: null,
        graceSuccessorCiphertext: null,
        graceExpiresAt: null,
        clientHost: null,
        refreshExpiresAt: null,
      };
      sessions.set(input.id, session);
      return { ok: true, value: session };
    },

    async getSessionByTokenHash(tokenHash: string): Promise<IdentityResult<Session>> {
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash) return { ok: true, value: s };
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async getSessionWithUserByTokenHash(
      tokenHash: string,
    ): Promise<IdentityResult<{ session: Session; user: User }>> {
      // Mirrors getSessionByTokenHash (no revoked/expired filter — the service
      // applies those) + getUserById, as one folded lookup (PERF12d).
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash) {
          const user = users.get(s.userId);
          if (!user) return { ok: false, error: { kind: "not_found" } };
          return { ok: true, value: { session: s, user } };
        }
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async revokeSession(id: string, revokedAt: Date): Promise<IdentityResult<Session>> {
      const s = sessions.get(id);
      if (!s) return { ok: false, error: { kind: "not_found" } };
      s.revokedAt = revokedAt;
      return { ok: true, value: s };
    },

    // --- CLI sessions ---

    async createCliSession(input: CreateCliSessionInput): Promise<IdentityResult<Session>> {
      const session: StoredSession = {
        id: input.id,
        userId: input.userId,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: input.createdAt,
        lastSeenAt: input.createdAt,
        tokenHash: input.tokenHash,
        kind: "cli",
        refreshTokenHash: input.refreshTokenHash,
        refreshFamilyId: input.refreshFamilyId,
        refreshGeneration: input.refreshGeneration,
        replacedBy: null,
        revokedReason: null,
        graceSuccessorCiphertext: null,
        graceExpiresAt: null,
        clientHost: input.clientHost ?? null,
        refreshExpiresAt: input.refreshExpiresAt,
      };
      sessions.set(input.id, session);
      return { ok: true, value: session };
    },

    async getCliSessionByRefreshHash(refreshTokenHash: string): Promise<IdentityResult<CliSessionByRefresh>> {
      // Hash is kept across generations (mirrors the repo): a rotated/revoked
      // token still resolves to its row so the service can detect reuse.
      for (const s of sessions.values()) {
        if (s.refreshTokenHash === refreshTokenHash) {
          const user = users.get(s.userId);
          if (!user) return { ok: false, error: { kind: "not_found" } };
          // Family origin = earliest created_at across the family (mirrors the
          // repo's MIN(created_at) subquery), backing the absolute cap.
          let familyStartedAt = s.createdAt;
          if (s.refreshFamilyId) {
            for (const f of sessions.values()) {
              if (f.refreshFamilyId === s.refreshFamilyId && f.createdAt < familyStartedAt) {
                familyStartedAt = f.createdAt;
              }
            }
          }
          return {
            ok: true,
            value: {
              session: s,
              user,
              familyStartedAt,
              graceSuccessorCiphertext: s.graceSuccessorCiphertext,
              graceExpiresAt: s.graceExpiresAt,
            },
          };
        }
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async getSessionById(id: string): Promise<IdentityResult<Session>> {
      const s = sessions.get(id);
      if (!s) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: s };
    },

    async rotateCliSession(input: RotateCliSessionInput): Promise<IdentityResult<Session>> {
      const current = sessions.get(input.currentSessionId);
      // Single-use: only the live row (not yet replaced/revoked) can rotate. The
      // hash is KEPT so a later replay of this token is detectable as reuse.
      if (!current || current.replacedBy !== null || current.revokedAt !== null) {
        return { ok: false, error: { kind: "conflict", entity: "session" } };
      }
      current.replacedBy = input.newSessionId;
      current.revokedAt = input.rotatedAt;
      current.revokedReason = "superseded";
      current.graceSuccessorCiphertext = input.graceSuccessorCiphertext ?? null;
      current.graceExpiresAt = input.graceExpiresAt ?? null;
      const next: StoredSession = {
        id: input.newSessionId,
        userId: input.userId,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: input.rotatedAt,
        lastSeenAt: input.rotatedAt,
        tokenHash: input.newTokenHash,
        kind: "cli",
        refreshTokenHash: input.newRefreshTokenHash,
        refreshFamilyId: input.refreshFamilyId,
        refreshGeneration: input.newRefreshGeneration,
        replacedBy: null,
        revokedReason: null,
        graceSuccessorCiphertext: null,
        graceExpiresAt: null,
        clientHost: input.clientHost ?? null,
        refreshExpiresAt: input.refreshExpiresAt,
      };
      sessions.set(next.id, next);
      return { ok: true, value: next };
    },

    async revokeCliFamily(refreshFamilyId: string, reason: string, revokedAt: Date): Promise<IdentityResult<number>> {
      let count = 0;
      for (const s of sessions.values()) {
        // Revoke still-live rows; keep hashes (reuse stays detectable; validity
        // is gated on revoked_at).
        if (s.refreshFamilyId === refreshFamilyId && s.revokedAt === null) {
          s.revokedAt = revokedAt;
          if (s.revokedReason === null) s.revokedReason = reason;
          count++;
        }
      }
      return { ok: true, value: count };
    },

    async revokeSessionWithReason(id: string, reason: string, revokedAt: Date): Promise<IdentityResult<Session>> {
      const s = sessions.get(id);
      if (!s || s.revokedAt !== null) return { ok: false, error: { kind: "not_found" } };
      s.revokedAt = revokedAt;
      s.revokedReason = reason;
      return { ok: true, value: s };
    },

    async listCliSessionsByUser(userId: string): Promise<IdentityResult<Session[]>> {
      const byFamily = new Map<string, StoredSession>();
      for (const s of sessions.values()) {
        if (s.userId !== userId || s.kind !== "cli") continue;
        const key = s.refreshFamilyId ?? s.id;
        const existing = byFamily.get(key);
        if (!existing) {
          byFamily.set(key, s);
        } else {
          const better = (s.refreshTokenHash !== null) || s.refreshGeneration > existing.refreshGeneration;
          if (better) byFamily.set(key, s);
        }
      }
      const out = [...byFamily.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return { ok: true, value: out };
    },

    // --- CLI login grants ---

    async createCliLoginGrant(input: CreateCliLoginGrantInput): Promise<IdentityResult<CliLoginGrant>> {
      const grant: StoredGrant = {
        id: input.id,
        flow: input.flow,
        status: "pending",
        clientHost: input.clientHost ?? null,
        approvedBy: null,
        approvedAt: null,
        sessionId: null,
        redeemedAt: null,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        cliCodeHash: input.cliCodeHash ?? null,
        deviceCodeHash: input.deviceCodeHash ?? null,
        userCodeHash: input.userCodeHash ?? null,
      };
      grants.set(input.id, grant);
      return { ok: true, value: grant };
    },

    async getCliLoginGrantById(id: string): Promise<IdentityResult<CliLoginGrant>> {
      const g = grants.get(id);
      return g ? { ok: true, value: g } : { ok: false, error: { kind: "not_found" } };
    },

    async getCliLoginGrantByCliCodeHash(h: string): Promise<IdentityResult<CliLoginGrant>> {
      for (const g of grants.values()) if (g.cliCodeHash === h) return { ok: true, value: g };
      return { ok: false, error: { kind: "not_found" } };
    },

    async getCliLoginGrantByDeviceCodeHash(h: string): Promise<IdentityResult<CliLoginGrant>> {
      for (const g of grants.values()) if (g.deviceCodeHash === h) return { ok: true, value: g };
      return { ok: false, error: { kind: "not_found" } };
    },

    async getCliLoginGrantByUserCodeHash(h: string): Promise<IdentityResult<CliLoginGrant>> {
      for (const g of grants.values()) if (g.userCodeHash === h) return { ok: true, value: g };
      return { ok: false, error: { kind: "not_found" } };
    },

    async approveCliLoginGrant(id: string, approvedBy: string, approvedAt: Date): Promise<IdentityResult<CliLoginGrant>> {
      const g = grants.get(id);
      if (!g || g.status !== "pending") return { ok: false, error: { kind: "conflict", entity: "cli_login_grant" } };
      g.status = "approved";
      g.approvedBy = approvedBy;
      g.approvedAt = approvedAt;
      g.updatedAt = approvedAt;
      return { ok: true, value: g };
    },

    async denyCliLoginGrant(id: string, deniedAt: Date): Promise<IdentityResult<CliLoginGrant>> {
      const g = grants.get(id);
      if (!g || (g.status !== "pending" && g.status !== "approved")) {
        return { ok: false, error: { kind: "conflict", entity: "cli_login_grant" } };
      }
      g.status = "denied";
      g.updatedAt = deniedAt;
      return { ok: true, value: g };
    },

    async redeemCliLoginGrant(id: string, sessionId: string, redeemedAt: Date): Promise<IdentityResult<CliLoginGrant>> {
      const g = grants.get(id);
      if (!g || g.status !== "approved" || g.expiresAt.getTime() <= redeemedAt.getTime()) {
        return { ok: false, error: { kind: "conflict", entity: "cli_login_grant" } };
      }
      g.status = "redeemed";
      g.sessionId = sessionId;
      g.redeemedAt = redeemedAt;
      g.updatedAt = redeemedAt;
      return { ok: true, value: g };
    },

    async recordSecurityEvent(input: CreateSecurityEventInput): Promise<IdentityResult<SecurityEvent>> {
      const event: SecurityEvent = {
        id: input.id,
        eventType: input.eventType,
        outcome: input.outcome,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        challengeId: input.challengeId ?? null,
        requestId: input.requestId ?? null,
        correlationId: input.correlationId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        occurredAt: input.occurredAt ?? new Date(),
        createdAt: new Date(),
        metadata: input.metadata ?? {},
        redactPaths: input.redactPaths ?? [],
      };
      securityEvents.push(event);
      return { ok: true, value: event };
    },

    async querySecurityEventsByUser(params: SecurityEventPageQueryParams): Promise<IdentityResult<SecurityEventPagedResult>> {
      const userEvents = securityEvents
        .filter((e) => e.userId === params.userId)
        .sort((a, b) => {
          const timeDiff = b.occurredAt.getTime() - a.occurredAt.getTime();
          if (timeDiff !== 0) return timeDiff;
          return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
        });

      let filtered = userEvents;
      if (params.cursor) {
        const cursorTime = new Date(params.cursor.occurredAt).getTime();
        filtered = userEvents.filter((e) => {
          const t = e.occurredAt.getTime();
          return t < cursorTime || (t === cursorTime && e.id < params.cursor!.id);
        });
      }

      const fetchLimit = params.limit + 1;
      const page = filtered.slice(0, fetchLimit);

      let nextCursor = null;
      if (page.length > params.limit) {
        page.pop();
        const last = page[page.length - 1]!;
        nextCursor = { occurredAt: last.occurredAt.toISOString(), id: last.id };
      }

      return { ok: true, value: { items: page, nextCursor } };
    },

    async createServicePrincipal(input: CreateServicePrincipalInput): Promise<IdentityResult<ServicePrincipal>> {
      const sp: ServicePrincipal = {
        id: input.id,
        orgId: input.orgId,
        projectId: input.projectId ?? null,
        displayName: input.displayName,
        description: input.description ?? null,
        status: "active",
        createdBy: input.createdBy,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      servicePrincipals.set(input.id, sp);
      return { ok: true, value: sp };
    },

    async getServicePrincipalById(id: string): Promise<IdentityResult<ServicePrincipal>> {
      const sp = servicePrincipals.get(id);
      if (!sp) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: sp };
    },

    async listServicePrincipalsByOrg(orgId: string): Promise<IdentityResult<ServicePrincipal[]>> {
      const result = [...servicePrincipals.values()].filter(sp => sp.orgId === orgId);
      return { ok: true, value: result };
    },

    async createApiKey(input: CreateApiKeyInput): Promise<IdentityResult<ApiKey>> {
      const key: ApiKey & { keyHash: string } = {
        id: input.id,
        servicePrincipalId: input.servicePrincipalId,
        orgId: input.orgId,
        keyPrefix: input.keyPrefix,
        keyHash: input.keyHash,
        label: input.label ?? "",
        status: "active",
        expiresAt: input.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null,
        revokedBy: null,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      apiKeys.set(input.id, key);
      return { ok: true, value: key };
    },

    async getApiKeyByKeyHash(keyHash: string): Promise<IdentityResult<ApiKey>> {
      for (const k of apiKeys.values()) {
        if (k.keyHash === keyHash) return { ok: true, value: k };
      }
      return { ok: false, error: { kind: "not_found" } };
    },

    async listApiKeysByOrg(params: ApiKeyPageQueryParams): Promise<IdentityResult<ApiKeyPagedResult>> {
      const orgKeys = [...apiKeys.values()].filter(k => k.orgId === params.orgId);
      return { ok: true, value: { items: orgKeys, nextCursor: null } };
    },

    async revokeApiKey(id: string, revokedBy: string, revokedAt: Date): Promise<IdentityResult<ApiKey>> {
      const k = apiKeys.get(id);
      if (!k) return { ok: false, error: { kind: "not_found" } };
      k.revokedAt = revokedAt;
      k.revokedBy = revokedBy;
      k.status = "revoked";
      return { ok: true, value: k };
    },
  };

  return repo;
}
