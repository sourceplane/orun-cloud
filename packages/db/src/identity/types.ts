export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";

export type IdentityRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "expired" }
  | { kind: "already_consumed" }
  | { kind: "internal"; message: string };

export type IdentityResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: IdentityRepositoryError };

export interface User {
  id: string;
  email: string;
  emailLower: string;
  displayName: string | null;
  /** Slug of the org the user last worked in; a soft UI hint (see migration 160). */
  lastOrgSlug: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthIdentity {
  id: string;
  userId: string;
  provider: string;
  subject: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface LoginChallenge {
  id: string;
  userId: string;
  method: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export type SessionKind = "web" | "cli";

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
  /** 'web' (console) or 'cli' (Orun CLI). Older rows are 'web'. */
  kind: SessionKind;
  /** Token-family id shared across all rotations of one CLI login (cli only). */
  refreshFamilyId: string | null;
  /** Monotonic rotation counter within the family (0 for web sessions). */
  refreshGeneration: number;
  /** Successor session id once this row was rotated. */
  replacedBy: string | null;
  /** Why the session was revoked: logout | reuse_detected | console_revoke | superseded. */
  revokedReason: string | null;
  /** Reported CLI host label, for the console "Sessions & devices" list. */
  clientHost: string | null;
  /** Absolute refresh-token expiry (~30 days); independent of access expiry. */
  refreshExpiresAt: Date | null;
}

/** A CLI session resolved by its live refresh-token hash (token endpoint). */
export interface CliSessionByRefresh {
  session: Session;
  user: User;
  /** When the token FAMILY was first issued (generation 1's created_at), i.e.
   *  the original login time, carried across rotations. Backs the absolute
   *  session-lifetime cap on top of the sliding idle window. Null only for
   *  malformed rows with no family. */
  familyStartedAt: Date | null;
  /** Reuse-grace (R11): AES-256-GCM envelope of the successor refresh token,
   *  written on this row when it was rotated. Lets a replay of this (now-spent)
   *  token within the grace window be re-issued the same successor idempotently
   *  instead of revoking the family. Null when grace is disabled/unset. */
  graceSuccessorCiphertext: string | null;
  /** End of the reuse-grace window for this row's rotation; the ciphertext is
   *  only honored while this is in the future. */
  graceExpiresAt: Date | null;
}

export interface CreateCliSessionInput {
  id: string;
  userId: string;
  /** Hash of the opaque access-correlated session token (kept for parity with web sessions). */
  tokenHash: string;
  refreshTokenHash: string;
  refreshFamilyId: string;
  /** Generation of the freshly-minted refresh token (1 for the first). */
  refreshGeneration: number;
  expiresAt: Date;
  refreshExpiresAt: Date;
  clientHost?: string | null;
  createdAt: Date;
}

/** Atomically rotate a CLI session: null the presented hash, set the successor,
 *  and insert the next-generation session. Done in one repo call (one tx). */
export interface RotateCliSessionInput {
  /** The currently-live session row being rotated (its refresh was just redeemed). */
  currentSessionId: string;
  refreshFamilyId: string;
  userId: string;
  newSessionId: string;
  newTokenHash: string;
  newRefreshTokenHash: string;
  newRefreshGeneration: number;
  expiresAt: Date;
  refreshExpiresAt: Date;
  clientHost?: string | null;
  rotatedAt: Date;
  /** Reuse-grace (R11): encrypted successor-refresh envelope to stamp on the
   *  predecessor row, and the grace deadline. Both null disables grace for this
   *  rotation (revoke-on-reuse as before). */
  graceSuccessorCiphertext?: string | null;
  graceExpiresAt?: Date | null;
}

export interface CreateUserInput {
  id: string;
  email: string;
  emailLower: string;
  displayName?: string | null;
  createdAt: Date;
}

export interface CreateAuthIdentityInput {
  id: string;
  userId: string;
  provider: string;
  subject: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateLoginChallengeInput {
  id: string;
  userId: string;
  method: string;
  codeHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateSessionInput {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface SecurityEvent {
  id: string;
  eventType: string;
  outcome: string;
  userId: string | null;
  sessionId: string | null;
  challengeId: string | null;
  requestId: string | null;
  correlationId: string | null;
  ip: string | null;
  userAgent: string | null;
  occurredAt: Date;
  createdAt: Date;
  metadata: Record<string, unknown>;
  redactPaths: string[];
}

export interface CreateSecurityEventInput {
  id: string;
  eventType: string;
  outcome: string;
  userId?: string | null;
  sessionId?: string | null;
  challengeId?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
  redactPaths?: string[];
}

// --- Service Principals ---

export interface ServicePrincipal {
  id: string;
  orgId: string;
  projectId: string | null;
  displayName: string;
  description: string | null;
  status: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateServicePrincipalInput {
  id: string;
  orgId: Uuid;
  projectId?: Uuid | null;
  displayName: string;
  description?: string | null;
  createdBy: Uuid;
  createdAt: Date;
}

// --- API Keys ---

export interface ApiKey {
  id: string;
  servicePrincipalId: string;
  orgId: string;
  keyPrefix: string;
  label: string;
  status: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateApiKeyInput {
  id: string;
  servicePrincipalId: string;
  orgId: Uuid;
  keyPrefix: string;
  keyHash: string;
  label?: string;
  expiresAt?: Date | null;
  createdBy: Uuid;
  createdAt: Date;
}

export interface ApiKeyCursorPosition {
  createdAt: string;
  id: string;
}

export interface ApiKeyPageQueryParams {
  orgId: string;
  limit: number;
  cursor: ApiKeyCursorPosition | null;
}

export interface ApiKeyPagedResult {
  items: ApiKey[];
  nextCursor: ApiKeyCursorPosition | null;
}

export interface SecurityEventCursorPosition {
  occurredAt: string;
  id: string;
}

export interface SecurityEventPageQueryParams {
  userId: string;
  limit: number;
  cursor: SecurityEventCursorPosition | null;
}

export interface SecurityEventPagedResult {
  items: SecurityEvent[];
  nextCursor: SecurityEventCursorPosition | null;
}

// --- CLI login grants (loopback + device flows) ---

export type CliLoginGrantFlow = "loopback" | "device";
export type CliLoginGrantStatus = "pending" | "approved" | "denied" | "redeemed" | "expired";

export interface CliLoginGrant {
  id: string;
  flow: CliLoginGrantFlow;
  status: CliLoginGrantStatus;
  clientHost: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  sessionId: string | null;
  redeemedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCliLoginGrantInput {
  id: string;
  flow: CliLoginGrantFlow;
  /** Loopback: hash of the one-time cli_code. */
  cliCodeHash?: string | null;
  /** Device: hash of the machine-polled device_code. */
  deviceCodeHash?: string | null;
  /** Device: hash of the human-entered user_code. */
  userCodeHash?: string | null;
  clientHost?: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface UpdateUserProfileInput {
  /** Provide to change; omit to leave unchanged (partial update). */
  displayName?: string | null;
  /** Provide to change; omit to leave unchanged (partial update). */
  lastOrgSlug?: string | null;
  updatedAt: Date;
}

export interface IdentityRepository {
  createUser(input: CreateUserInput): Promise<IdentityResult<User>>;
  getUserById(id: string): Promise<IdentityResult<User>>;
  getUserByEmail(emailLower: string): Promise<IdentityResult<User>>;
  updateUserProfile(userId: string, input: UpdateUserProfileInput): Promise<IdentityResult<User>>;

  createAuthIdentity(input: CreateAuthIdentityInput): Promise<IdentityResult<AuthIdentity>>;
  getAuthIdentityByProviderSubject(provider: string, subject: string): Promise<IdentityResult<AuthIdentity>>;

  createLoginChallenge(input: CreateLoginChallengeInput): Promise<IdentityResult<LoginChallenge>>;
  getLoginChallengeById(id: string): Promise<IdentityResult<LoginChallenge>>;
  consumeLoginChallenge(id: string, codeHash: string, consumedAt: Date): Promise<IdentityResult<LoginChallenge>>;

  createSession(input: CreateSessionInput): Promise<IdentityResult<Session>>;
  getSessionByTokenHash(tokenHash: string): Promise<IdentityResult<Session>>;

  // --- CLI sessions (rotating refresh + token family) ---
  createCliSession(input: CreateCliSessionInput): Promise<IdentityResult<Session>>;
  /** Resolve the live CLI session whose current refresh-token hash matches. */
  getCliSessionByRefreshHash(refreshTokenHash: string): Promise<IdentityResult<CliSessionByRefresh>>;
  /** Fetch a single session row by id (any kind), for revoke / family lookups. */
  getSessionById(id: string): Promise<IdentityResult<Session>>;
  /**
   * Rotate a live CLI session in one transaction: null the presented refresh
   * hash on the current row, set its `replaced_by`, and insert the successor
   * generation. Returns the new (live) session row.
   */
  rotateCliSession(input: RotateCliSessionInput): Promise<IdentityResult<Session>>;
  /** Revoke an entire token family (reuse detection / console revoke). Returns count revoked. */
  revokeCliFamily(refreshFamilyId: string, reason: string, revokedAt: Date): Promise<IdentityResult<number>>;
  /** Revoke a single session (logout) with a reason. */
  revokeSessionWithReason(id: string, reason: string, revokedAt: Date): Promise<IdentityResult<Session>>;
  /** List a user's CLI sessions for the console "Sessions & devices" surface. */
  listCliSessionsByUser(userId: string): Promise<IdentityResult<Session[]>>;

  // --- CLI login grants (loopback + device flows) ---
  createCliLoginGrant(input: CreateCliLoginGrantInput): Promise<IdentityResult<CliLoginGrant>>;
  getCliLoginGrantById(id: string): Promise<IdentityResult<CliLoginGrant>>;
  getCliLoginGrantByCliCodeHash(cliCodeHash: string): Promise<IdentityResult<CliLoginGrant>>;
  getCliLoginGrantByDeviceCodeHash(deviceCodeHash: string): Promise<IdentityResult<CliLoginGrant>>;
  getCliLoginGrantByUserCodeHash(userCodeHash: string): Promise<IdentityResult<CliLoginGrant>>;
  /** Mark a grant approved by a console-authenticated user. */
  approveCliLoginGrant(id: string, approvedBy: string, approvedAt: Date): Promise<IdentityResult<CliLoginGrant>>;
  /** Mark a grant denied. */
  denyCliLoginGrant(id: string, deniedAt: Date): Promise<IdentityResult<CliLoginGrant>>;
  /**
   * Atomically redeem an approved grant: flip status pending/approved → redeemed
   * (only if not already redeemed/expired) and attach the minted session id.
   * Single-use: a second redeem returns `conflict`.
   */
  redeemCliLoginGrant(id: string, sessionId: string, redeemedAt: Date): Promise<IdentityResult<CliLoginGrant>>;
  /**
   * Session lookup folded with its user fetch into a single JOIN (PERF12d), so a
   * bearer-cache miss costs one DB round-trip instead of two. Same filters and
   * `not_found`/`expired` semantics as `getSessionByTokenHash`.
   */
  getSessionWithUserByTokenHash(tokenHash: string): Promise<IdentityResult<{ session: Session; user: User }>>;
  revokeSession(id: string, revokedAt: Date): Promise<IdentityResult<Session>>;

  recordSecurityEvent(input: CreateSecurityEventInput): Promise<IdentityResult<SecurityEvent>>;
  querySecurityEventsByUser(params: SecurityEventPageQueryParams): Promise<IdentityResult<SecurityEventPagedResult>>;

  // Service Principals
  createServicePrincipal(input: CreateServicePrincipalInput): Promise<IdentityResult<ServicePrincipal>>;
  getServicePrincipalById(id: string): Promise<IdentityResult<ServicePrincipal>>;
  listServicePrincipalsByOrg(orgId: string): Promise<IdentityResult<ServicePrincipal[]>>;

  // API Keys
  createApiKey(input: CreateApiKeyInput): Promise<IdentityResult<ApiKey>>;
  getApiKeyByKeyHash(keyHash: string): Promise<IdentityResult<ApiKey>>;
  listApiKeysByOrg(params: ApiKeyPageQueryParams): Promise<IdentityResult<ApiKeyPagedResult>>;
  revokeApiKey(id: string, revokedBy: Uuid, revokedAt: Date): Promise<IdentityResult<ApiKey>>;
}
