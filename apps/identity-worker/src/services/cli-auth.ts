// CLI session auth service (saas-orun-platform OP1).
//
// Encapsulates the browser-loopback + RFC-8628 device flows and the rotating
// refresh-token lifecycle. Mirrors `services/auth.ts`: the service takes a repo
// + clock + request context and returns plain result/error unions; the handlers
// own HTTP shaping. All grant/refresh secrets are hashed at rest; grants are
// single-use; refresh rotation is single-use with reuse-detection → family
// revoke. Every grant and revoke records an identity security event (the
// identity-context audit trail).

import type { IdentityRepository, Session, User } from "@saas/db/identity";
import type { CliSessionOrg, CliSessionPayload } from "@saas/contracts/auth";
import type { Env } from "../env.js";
import { hashSha256 } from "../crypto.js";
import { mintCliAccessToken } from "../cli/jwt.js";
import {
  generateCliCode,
  generateDeviceCode,
  generateUserCode,
  generateRefreshToken,
  generateSessionTokenSecret,
  normalizeUserCode,
  cliGrantPublicId,
  parseCliGrantPublicId,
  cliSessionPublicId,
  parseCliSessionPublicId,
} from "../cli/secrets.js";
import { generateSessionId, generateSecurityEventId, userPublicId } from "../ids.js";

export interface CliRequestContext {
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CliAuthServiceDeps {
  repo: IdentityRepository;
  env: Env;
  now: () => Date;
  ctx?: CliRequestContext;
  /** Resolve the user's orgs (with role) for the session payload. Failure-soft:
   *  returns [] when membership is unreachable. */
  fetchOrgs: (subjectId: string) => Promise<CliSessionOrg[]>;
}

// TTLs.
const GRANT_TTL_MS = 10 * 60 * 1000; // loopback + device approval window
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days
const DEVICE_POLL_INTERVAL_SEC = 5;

export interface CliStartResult {
  authorizeUrl: string;
  cliCode: string;
  expiresAt: Date;
  grantId: string;
}

export interface CliDeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresAt: Date;
}

export type CliDevicePollResult =
  | { kind: "pending" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "complete"; session: CliSessionPayload };

export type CliError = { error: "invalid_request" | "not_found" | "expired" | "internal_error" | "signing_unavailable"; message: string };

function consoleBaseUrl(env: Env): string {
  if (env.CLI_CONSOLE_BASE_URL && env.CLI_CONSOLE_BASE_URL.trim()) {
    return env.CLI_CONSOLE_BASE_URL.trim().replace(/\/+$/, "");
  }
  const first = (env.OAUTH_ALLOWED_CONSOLE_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return (first ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function createCliAuthService(deps: CliAuthServiceDeps) {
  const { repo, env, now, ctx, fetchOrgs } = deps;

  function eventBase() {
    return {
      id: generateSecurityEventId(),
      requestId: ctx?.requestId ?? null,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      occurredAt: now(),
    };
  }

  /** Mint a fresh CLI session (new family, generation 1) for `user`, build the
   *  full session payload (access JWT + refresh + user + orgs). */
  async function mintSession(
    user: User,
    clientHost: string | null,
  ): Promise<{ payload: CliSessionPayload; session: Session } | CliError> {
    const sessionUuid = generateSessionId();
    const refreshFamilyId = crypto.randomUUID();
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = await hashSha256(refreshToken);
    const tokenHash = await hashSha256(generateSessionTokenSecret());
    const currentTime = now();
    const expiresAt = new Date(currentTime.getTime() + REFRESH_TTL_MS);

    const created = await repo.createCliSession({
      id: sessionUuid,
      userId: user.id,
      tokenHash,
      refreshTokenHash,
      refreshFamilyId,
      refreshGeneration: 1,
      // sessions.expires_at mirrors the refresh expiry (the session lives as long
      // as the refresh is valid); the access token carries its own short exp.
      expiresAt,
      refreshExpiresAt: expiresAt,
      clientHost,
      createdAt: currentTime,
    });
    if (!created.ok) return { error: "internal_error", message: "Failed to create CLI session" };

    const subPublic = userPublicId(user.id);
    const orgs = await fetchOrgs(subPublic);
    let access: { token: string; expiresAt: Date };
    try {
      access = await mintCliAccessToken(env, {
        sub: subPublic,
        sessionId: cliSessionPublicId(sessionUuid),
        orgIds: orgs.map((o) => o.id),
        now: currentTime,
      });
    } catch {
      return { error: "signing_unavailable", message: "CLI token signing is not configured" };
    }

    await repo.recordSecurityEvent({
      ...eventBase(),
      eventType: "cli.session.created",
      outcome: "success",
      userId: user.id,
      sessionId: sessionUuid,
      metadata: { clientHost, refreshFamilyId },
    });

    return {
      session: created.value,
      payload: buildPayload(access, refreshToken, user, orgs),
    };
  }

  function buildPayload(
    access: { token: string; expiresAt: Date },
    refreshToken: string,
    user: User,
    orgs: CliSessionOrg[],
  ): CliSessionPayload {
    return {
      accessToken: access.token,
      expiresAt: access.expiresAt.toISOString(),
      refreshToken,
      user: { id: userPublicId(user.id), email: user.email, displayName: user.displayName },
      orgs,
    };
  }

  return {
    /** POST /v1/auth/cli/start — browser loopback. Creates a pending grant. */
    async start(clientHost: string | null): Promise<CliStartResult | CliError> {
      const cliCode = generateCliCode();
      const cliCodeHash = await hashSha256(cliCode);
      const grantUuid = crypto.randomUUID();
      const currentTime = now();
      const expiresAt = new Date(currentTime.getTime() + GRANT_TTL_MS);

      const created = await repo.createCliLoginGrant({
        id: grantUuid,
        flow: "loopback",
        cliCodeHash,
        clientHost,
        expiresAt,
        createdAt: currentTime,
      });
      if (!created.ok) return { error: "internal_error", message: "Failed to start CLI login" };

      const grantPublic = cliGrantPublicId(grantUuid);
      const authorizeUrl = `${consoleBaseUrl(env)}/cli/approve?grant=${encodeURIComponent(grantPublic)}`;

      await repo.recordSecurityEvent({
        ...eventBase(),
        eventType: "cli.grant.created",
        outcome: "success",
        metadata: { flow: "loopback", grantId: grantPublic, clientHost },
      });

      return { authorizeUrl, cliCode, expiresAt, grantId: grantPublic };
    },

    /** POST /v1/auth/cli/device/start — RFC-8628. */
    async deviceStart(clientHost: string | null): Promise<CliDeviceStartResult | CliError> {
      const deviceCode = generateDeviceCode();
      const userCode = generateUserCode();
      const deviceCodeHash = await hashSha256(deviceCode);
      const userCodeHash = await hashSha256(userCode);
      const grantUuid = crypto.randomUUID();
      const currentTime = now();
      const expiresAt = new Date(currentTime.getTime() + GRANT_TTL_MS);

      const created = await repo.createCliLoginGrant({
        id: grantUuid,
        flow: "device",
        deviceCodeHash,
        userCodeHash,
        clientHost,
        expiresAt,
        createdAt: currentTime,
      });
      if (!created.ok) return { error: "internal_error", message: "Failed to start device login" };

      await repo.recordSecurityEvent({
        ...eventBase(),
        eventType: "cli.grant.created",
        outcome: "success",
        metadata: { flow: "device", grantId: cliGrantPublicId(grantUuid), clientHost },
      });

      return {
        deviceCode,
        userCode,
        verificationUrl: `${consoleBaseUrl(env)}/cli/device`,
        interval: DEVICE_POLL_INTERVAL_SEC,
        expiresAt,
      };
    },

    /** POST /v1/auth/cli/device/poll. */
    async devicePoll(deviceCode: string): Promise<CliDevicePollResult | CliError> {
      const grantResult = await repo.getCliLoginGrantByDeviceCodeHash(await hashSha256(deviceCode));
      if (!grantResult.ok) return { error: "not_found", message: "Unknown device code" };
      const grant = grantResult.value;

      if (grant.status === "denied") return { kind: "denied" };
      if (grant.status === "expired" || grant.expiresAt.getTime() <= now().getTime()) {
        return { kind: "expired" };
      }
      if (grant.status === "pending") return { kind: "pending" };
      if (grant.status === "redeemed") return { error: "expired", message: "Device code already used" };
      // status === 'approved' → redeem now (atomic single-use) and mint.
      return this.redeemApprovedGrant(grant.id, grant.clientHost);
    },

    /**
     * POST /v1/auth/cli/token with grantType "cli_code" (loopback redeem).
     * Single-use: the grant must be approved and unredeemed.
     */
    async redeemCliCode(cliCode: string): Promise<CliSessionPayload | CliError> {
      const grantResult = await repo.getCliLoginGrantByCliCodeHash(await hashSha256(cliCode));
      if (!grantResult.ok) return { error: "not_found", message: "Unknown or used code" };
      const grant = grantResult.value;
      if (grant.expiresAt.getTime() <= now().getTime()) {
        return { error: "expired", message: "Login request expired" };
      }
      if (grant.status === "pending") return { error: "invalid_request", message: "Not yet approved" };
      if (grant.status !== "approved") return { error: "invalid_request", message: "Code is no longer valid" };
      const result = await this.redeemApprovedGrant(grant.id, grant.clientHost);
      if ("error" in result) return result;
      if (result.kind !== "complete") return { error: "invalid_request", message: "Grant not approved" };
      return result.session;
    },

    /** Shared redeem path for an approved grant (loopback + device). */
    async redeemApprovedGrant(grantId: string, clientHost: string | null): Promise<CliDevicePollResult | CliError> {
      const grantResult = await repo.getCliLoginGrantById(grantId);
      if (!grantResult.ok) return { error: "not_found", message: "Grant not found" };
      const grant = grantResult.value;
      if (grant.status !== "approved" || !grant.approvedBy) {
        return { kind: "pending" };
      }
      const approverUuid = parseCliApprover(grant.approvedBy);
      if (!approverUuid) return { error: "internal_error", message: "Invalid approver" };

      const userResult = await repo.getUserById(approverUuid);
      if (!userResult.ok) return { error: "internal_error", message: "Approver not found" };

      const minted = await mintSession(userResult.value, clientHost);
      if ("error" in minted) return minted;

      // Single-use: flip the grant to redeemed, binding the minted session. A
      // concurrent second redeem loses the conditional UPDATE → treat as used.
      const redeemed = await repo.redeemCliLoginGrant(grantId, minted.session.id, now());
      if (!redeemed.ok) {
        // Someone already redeemed; revoke the just-minted session to avoid an
        // orphaned grant-less session and report the race as expired.
        if (minted.session.refreshFamilyId) {
          await repo.revokeCliFamily(minted.session.refreshFamilyId, "superseded", now());
        }
        return { error: "expired", message: "Code already used" };
      }
      return { kind: "complete", session: minted.payload };
    },

    /**
     * POST /v1/auth/cli/token with grantType "refresh_token". Rotating + single
     * use: presenting the live refresh mints the next generation; presenting an
     * already-rotated (or revoked) refresh ⇒ revoke the whole family.
     */
    async refresh(refreshToken: string): Promise<CliSessionPayload | CliError> {
      const refreshTokenHash = await hashSha256(refreshToken);
      const found = await repo.getCliSessionByRefreshHash(refreshTokenHash);
      if (!found.ok) {
        // The token has never existed (or expired off the table). Not reuse —
        // just an invalid token. Report unauthenticated.
        return { error: "not_found", message: "Invalid refresh token" };
      }
      const { session, user } = found.value;

      // Reuse detection (RFC-9700): the presented token resolved to a row, but
      // that row is no longer the live generation — it was already rotated
      // (replaced_by set) or revoked. Presenting a superseded token means an
      // attacker (or a buggy client) replayed it ⇒ revoke the WHOLE family so the
      // legitimate holder is forced to re-login.
      if (session.replacedBy !== null || session.revokedAt !== null) {
        if (session.refreshFamilyId) {
          await repo.revokeCliFamily(session.refreshFamilyId, "reuse_detected", now());
          await repo.recordSecurityEvent({
            ...eventBase(),
            eventType: "cli.refresh.reuse_detected",
            outcome: "failure",
            userId: user.id,
            metadata: { refreshFamilyId: session.refreshFamilyId, generation: session.refreshGeneration },
          });
        }
        return { error: "not_found", message: "Refresh token reuse detected; session revoked" };
      }
      if (session.refreshExpiresAt && session.refreshExpiresAt.getTime() <= now().getTime()) {
        return { error: "expired", message: "Refresh token expired" };
      }
      if (!session.refreshFamilyId) {
        return { error: "internal_error", message: "Malformed CLI session" };
      }

      // Mint the next generation.
      const newSessionId = generateSessionId();
      const newRefreshToken = generateRefreshToken();
      const newRefreshTokenHash = await hashSha256(newRefreshToken);
      const newTokenHash = await hashSha256(generateSessionTokenSecret());
      const currentTime = now();
      const refreshExpiresAt = session.refreshExpiresAt ?? new Date(currentTime.getTime() + REFRESH_TTL_MS);

      const rotated = await repo.rotateCliSession({
        currentSessionId: session.id,
        refreshFamilyId: session.refreshFamilyId,
        userId: user.id,
        newSessionId,
        newTokenHash,
        newRefreshTokenHash,
        newRefreshGeneration: session.refreshGeneration + 1,
        expiresAt: refreshExpiresAt,
        refreshExpiresAt,
        clientHost: session.clientHost,
        rotatedAt: currentTime,
      });
      if (!rotated.ok) {
        // Lost the rotation race → the token was used twice concurrently. Reuse:
        // revoke the family.
        await repo.revokeCliFamily(session.refreshFamilyId, "reuse_detected", currentTime);
        await repo.recordSecurityEvent({
          ...eventBase(),
          eventType: "cli.refresh.reuse_detected",
          outcome: "failure",
          userId: user.id,
          metadata: { refreshFamilyId: session.refreshFamilyId },
        });
        return { error: "not_found", message: "Refresh token reuse detected; session revoked" };
      }

      const orgs = await fetchOrgs(userPublicId(user.id));
      let access: { token: string; expiresAt: Date };
      try {
        access = await mintCliAccessToken(env, {
          sub: userPublicId(user.id),
          sessionId: cliSessionPublicId(newSessionId),
          orgIds: orgs.map((o) => o.id),
          now: currentTime,
        });
      } catch {
        return { error: "signing_unavailable", message: "CLI token signing is not configured" };
      }

      await repo.recordSecurityEvent({
        ...eventBase(),
        eventType: "cli.session.refreshed",
        outcome: "success",
        userId: user.id,
        sessionId: newSessionId,
        metadata: { refreshFamilyId: session.refreshFamilyId, generation: session.refreshGeneration + 1 },
      });

      return buildPayload(access, newRefreshToken, user, orgs);
    },

    /** POST /v1/auth/cli/revoke — revoke the session behind this refresh token. */
    async revoke(refreshToken: string): Promise<{ success: true } | CliError> {
      const found = await repo.getCliSessionByRefreshHash(await hashSha256(refreshToken));
      if (!found.ok) {
        // Idempotent: already revoked/rotated tokens just report success.
        return { success: true };
      }
      const { session, user } = found.value;
      if (session.refreshFamilyId) {
        await repo.revokeCliFamily(session.refreshFamilyId, "logout", now());
      } else {
        await repo.revokeSessionWithReason(session.id, "logout", now());
      }
      await repo.recordSecurityEvent({
        ...eventBase(),
        eventType: "cli.session.revoked",
        outcome: "success",
        userId: user.id,
        sessionId: session.id,
        metadata: { reason: "logout" },
      });
      return { success: true };
    },

    // --- Console-side grant management ---

    /** Resolve a grant for the approval page — by public grant id (loopback) or
     *  by the human-entered user code (device). */
    async getGrant(opts: { grantId?: string; userCode?: string }): Promise<
      { grant: import("@saas/db/identity").CliLoginGrant; publicId: string } | CliError
    > {
      if (opts.grantId) {
        const uuid = parseCliGrantPublicId(opts.grantId);
        if (!uuid) return { error: "invalid_request", message: "Invalid grant id" };
        const r = await repo.getCliLoginGrantById(uuid);
        if (!r.ok) return { error: "not_found", message: "Grant not found" };
        return { grant: r.value, publicId: opts.grantId };
      }
      if (opts.userCode) {
        const r = await repo.getCliLoginGrantByUserCodeHash(await hashSha256(normalizeUserCode(opts.userCode)));
        if (!r.ok) return { error: "not_found", message: "Code not found" };
        return { grant: r.value, publicId: cliGrantPublicId(r.value.id) };
      }
      return { error: "invalid_request", message: "grant or userCode required" };
    },

    /** Approve a pending grant. `approverUserUuid` is the console user's UUID. */
    async approveGrant(
      grantId: string,
      approverUserUuid: string,
    ): Promise<{ publicId: string; status: string; flow: string; host: string | null } | CliError> {
      const uuid = parseCliGrantPublicId(grantId);
      if (!uuid) return { error: "invalid_request", message: "Invalid grant id" };
      const existing = await repo.getCliLoginGrantById(uuid);
      if (!existing.ok) return { error: "not_found", message: "Grant not found" };
      if (existing.value.expiresAt.getTime() <= now().getTime()) {
        return { error: "expired", message: "Login request expired" };
      }
      // approved_by stores the public user id so the redeem path can resolve the
      // user; encode it here.
      const approved = await repo.approveCliLoginGrant(uuid, userPublicId(approverUserUuid), now());
      if (!approved.ok) return { error: "invalid_request", message: "Grant is no longer pending" };

      await repo.recordSecurityEvent({
        ...eventBase(),
        eventType: "cli.grant.approved",
        outcome: "success",
        userId: approverUserUuid,
        metadata: { grantId, flow: approved.value.flow },
      });
      return { publicId: grantId, status: approved.value.status, flow: approved.value.flow, host: approved.value.clientHost };
    },

    /** Deny a pending/approved grant. */
    async denyGrant(
      grantId: string,
      approverUserUuid: string,
    ): Promise<{ publicId: string; status: string; flow: string; host: string | null } | CliError> {
      const uuid = parseCliGrantPublicId(grantId);
      if (!uuid) return { error: "invalid_request", message: "Invalid grant id" };
      const denied = await repo.denyCliLoginGrant(uuid, now());
      if (!denied.ok) return { error: "invalid_request", message: "Grant cannot be denied" };
      await repo.recordSecurityEvent({
        ...eventBase(),
        eventType: "cli.grant.denied",
        outcome: "success",
        userId: approverUserUuid,
        metadata: { grantId, flow: denied.value.flow },
      });
      return { publicId: grantId, status: denied.value.status, flow: denied.value.flow, host: denied.value.clientHost };
    },

    // --- Sessions & devices listing / per-session revoke ---

    async listSessions(userUuid: string): Promise<Session[] | CliError> {
      const r = await repo.listCliSessionsByUser(userUuid);
      if (!r.ok) return { error: "internal_error", message: "Failed to list sessions" };
      return r.value;
    },

    async revokeSessionById(userUuid: string, sessionPublicId: string): Promise<Session | CliError> {
      const sessionUuid = parseCliSessionPublicId(sessionPublicId);
      if (!sessionUuid) return { error: "invalid_request", message: "Invalid session id" };
      const sessionResult = await repo.getSessionById(sessionUuid);
      if (!sessionResult.ok) return { error: "not_found", message: "Session not found" };
      const session = sessionResult.value;
      // Authorization: a user may only revoke their own CLI sessions.
      if (session.userId !== userUuid || session.kind !== "cli") {
        return { error: "not_found", message: "Session not found" };
      }
      if (session.refreshFamilyId) {
        await repo.revokeCliFamily(session.refreshFamilyId, "console_revoke", now());
      } else {
        await repo.revokeSessionWithReason(session.id, "console_revoke", now());
      }
      await repo.recordSecurityEvent({
        ...eventBase(),
        eventType: "cli.session.revoked",
        outcome: "success",
        userId: userUuid,
        sessionId: session.id,
        metadata: { reason: "console_revoke" },
      });
      const refetch = await repo.getSessionById(session.id);
      return refetch.ok ? refetch.value : session;
    },
  };
}

/** approved_by is stored as the public user id (`usr_<hex>`); decode to UUID. */
function parseCliApprover(approvedBy: string): string | null {
  if (!approvedBy.startsWith("usr_")) return null;
  // Reuse the canonical parse from ids: inline hex→uuid to avoid a cycle.
  const hex = approvedBy.slice(4);
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
