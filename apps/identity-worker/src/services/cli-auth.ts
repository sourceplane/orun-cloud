// CLI session auth service (saas-orun-platform OP1).
//
// Encapsulates the browser-loopback + RFC-8628 device flows and the rotating
// refresh-token lifecycle. Mirrors `services/auth.ts`: the service takes a repo
// + clock + request context and returns plain result/error unions; the handlers
// own HTTP shaping. All grant/refresh secrets are hashed at rest; grants are
// single-use; refresh rotation is single-use with reuse-detection → family
// revoke. Every grant and revoke records an identity security event (the
// identity-context audit trail).

import type { IdentityRepository, Session, User, CliSessionByRefresh } from "@saas/db/identity";
import type { CliSessionOrg, CliSessionPayload } from "@saas/contracts/auth";
import type { Env } from "../env.js";
import { hashSha256 } from "../crypto.js";
import { mintCliAccessToken, MCP_ACCESS_TOKEN_TTL_MS } from "../cli/jwt.js";

// An MCP OAuth grant stamps the session's clientHost as `mcp:<clientId>`; such
// sessions get the longer access-token TTL (see MCP_ACCESS_TOKEN_TTL_MS). All
// other CLI flows keep the short default.
function accessTtlFor(clientHost: string | null): number | undefined {
  return clientHost?.startsWith("mcp:") ? MCP_ACCESS_TOKEN_TTL_MS : undefined;
}
import { encryptGraceSuccessor, decryptGraceSuccessor } from "../cli/grace-crypto.js";
import {
  generateCliCode,
  generateDeviceCode,
  generateUserCode,
  generateOAuthAuthorizationCode,
  generateRefreshToken,
  generateSessionTokenSecret,
  normalizeUserCode,
  cliGrantPublicId,
  parseCliGrantPublicId,
  cliSessionPublicId,
  parseCliSessionPublicId,
} from "../cli/secrets.js";
import { computeS256Challenge, challengeMatches } from "../oauth2/pkce.js";
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
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days (sliding idle window)
// Absolute lifetime of a single login regardless of activity: even a
// continuously-used session must re-authenticate after this long, bounding the
// blast radius of a silently-compromised refresh-token family (compliance: a
// hard max session age). The sliding idle window (REFRESH_TTL_MS) is capped by
// this on every rotation.
const ABSOLUTE_REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // ~90 days
const DEVICE_POLL_INTERVAL_SEC = 5;
// Reuse-grace window (risk R11): a replay of a just-rotated refresh token within
// this window is re-issued the same successor idempotently rather than revoking
// the family. Kept tight — it only needs to span an in-flight retry of a lost
// rotation response, or two near-simultaneous redemptions of one token.
const REFRESH_GRACE_TTL_MS = 10 * 1000; // ~10s
// OAuth 2.1 authorization codes (MCP3) are single-use and very short-lived —
// they only need to survive one browser redirect + one token request.
const OAUTH_CODE_TTL_MS = 60 * 1000; // ~60s

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

/** MCP3: errors from the OAuth code-redeem path, pre-shaped as RFC 6749 §5.2
 *  token-endpoint error codes (the handler maps them 1:1 onto the wire). */
export type OAuthRedeemError = {
  error: "invalid_grant" | "invalid_request" | "internal_error" | "signing_unavailable";
  message: string;
};

export interface OAuthAuthorizeCompleteInput {
  /** Vetted public client (D1 Option A) — validated by the handler BEFORE this call. */
  clientId: string;
  /** Exact redirect_uri presented on authorize — validated by the handler. */
  redirectUri: string;
  /** PKCE S256 code challenge (shape-validated by the handler). */
  codeChallenge: string;
  /** The consenting console user (from the api-edge actor headers). */
  approverUserUuid: string;
}

export interface OAuthRedeemCodeInput {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}

export function consoleBaseUrl(env: Env): string {
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
      const accessTtlMs = accessTtlFor(clientHost);
      access = await mintCliAccessToken(env, {
        sub: subPublic,
        sessionId: cliSessionPublicId(sessionUuid),
        orgIds: orgs.map((o) => o.id),
        ...workspaceIdsOf(orgs),
        now: currentTime,
        ...(accessTtlMs !== undefined ? { ttlMs: accessTtlMs } : {}),
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

  // Reuse-grace (risk R11). A presented refresh token that resolves to an
  // already-rotated row is normally reuse → revoke the whole family. But a
  // replay of a JUST-rotated token (a normal 'superseded' rotation) within the
  // grace window is benign — a lost-response retry, or a second near-simultaneous
  // redemption that lost the rotation race — so re-issue the SAME successor
  // idempotently: a fresh (stateless) access JWT for the successor session plus
  // the stored successor refresh token. Everything else still revokes.
  async function graceReplayOrRevoke(found: CliSessionByRefresh): Promise<CliSessionPayload | CliError> {
    const { session, user } = found;
    const eligible =
      session.replacedBy !== null &&
      session.revokedReason === "superseded" &&
      found.graceSuccessorCiphertext !== null &&
      found.graceExpiresAt !== null &&
      found.graceExpiresAt.getTime() > now().getTime();
    if (eligible) {
      const successorRefresh = await decryptGraceSuccessor(env, found.graceSuccessorCiphertext!);
      if (successorRefresh) {
        const orgs = await fetchOrgs(userPublicId(user.id));
        let access: { token: string; expiresAt: Date };
        try {
          const graceTtlMs = accessTtlFor(session.clientHost);
          access = await mintCliAccessToken(env, {
            sub: userPublicId(user.id),
            sessionId: cliSessionPublicId(session.replacedBy!),
            orgIds: orgs.map((o) => o.id),
            ...workspaceIdsOf(orgs),
            now: now(),
            ...(graceTtlMs !== undefined ? { ttlMs: graceTtlMs } : {}),
          });
        } catch {
          return { error: "signing_unavailable", message: "CLI token signing is not configured" };
        }
        await repo.recordSecurityEvent({
          ...eventBase(),
          eventType: "cli.refresh.grace_replay",
          outcome: "success",
          userId: user.id,
          sessionId: session.replacedBy!,
          metadata: { refreshFamilyId: session.refreshFamilyId, generation: session.refreshGeneration },
        });
        return buildPayload(access, successorRefresh, user, orgs);
      }
    }
    // Not grace-eligible (window elapsed, no ciphertext, a non-supersede revoke,
    // or decryption failed) → genuine reuse → revoke the family.
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
      const { session, user, familyStartedAt } = found.value;

      // Reuse detection (RFC-9700): the presented token resolved to a row, but
      // that row is no longer the live generation — it was already rotated
      // (replaced_by set) or revoked. This is reuse ⇒ normally revoke the WHOLE
      // family. The grace helper re-issues the successor idempotently instead,
      // but ONLY for a just-rotated ('superseded') token still inside its grace
      // window; anything else still revokes (risk R11).
      if (session.replacedBy !== null || session.revokedAt !== null) {
        return graceReplayOrRevoke(found.value);
      }
      if (!session.refreshFamilyId) {
        return { error: "internal_error", message: "Malformed CLI session" };
      }

      // Absolute lifetime cap (checked before the idle-expiry below): even an
      // actively-refreshed family must re-authenticate once it is older than
      // ABSOLUTE_REFRESH_TTL_MS. The sliding idle window keeps an active session
      // alive, but never past this hard ceiling — so a silently-compromised
      // family cannot live forever. Hitting the cap retires the family (distinct
      // from a plain idle timeout, which just lets the token age out).
      const familyStart = (familyStartedAt ?? session.createdAt).getTime();
      const absoluteDeadline = familyStart + ABSOLUTE_REFRESH_TTL_MS;
      if (now().getTime() >= absoluteDeadline) {
        await repo.revokeCliFamily(session.refreshFamilyId, "absolute_expiry", now());
        await repo.recordSecurityEvent({
          ...eventBase(),
          eventType: "cli.session.absolute_expiry",
          outcome: "success",
          userId: user.id,
          sessionId: session.id,
          metadata: { refreshFamilyId: session.refreshFamilyId, familyStartedAt: new Date(familyStart).toISOString() },
        });
        return { error: "expired", message: "Session reached its maximum lifetime; sign in again" };
      }

      if (session.refreshExpiresAt && session.refreshExpiresAt.getTime() <= now().getTime()) {
        return { error: "expired", message: "Refresh token expired" };
      }

      // Mint the next generation.
      const newSessionId = generateSessionId();
      const newRefreshToken = generateRefreshToken();
      const newRefreshTokenHash = await hashSha256(newRefreshToken);
      const newTokenHash = await hashSha256(generateSessionTokenSecret());
      const currentTime = now();
      // Sliding idle window, clamped by the absolute deadline: every refresh
      // extends the refresh-token lifetime from "now" (so an actively-used CLI
      // session never forces a surprise re-login, while an idle one expires
      // REFRESH_TTL_MS after its last use) — but never past the family's
      // absolute lifetime cap. Previously the original family expiry was carried
      // forward, which hard-logged-out even active users 30 days after first
      // login.
      const refreshExpiresAt = new Date(
        Math.min(currentTime.getTime() + REFRESH_TTL_MS, absoluteDeadline),
      );

      // Reuse-grace (R11): stamp the (encrypted) successor refresh token + a
      // grace deadline on the predecessor row, so a benign replay of the token
      // we are spending now can be re-issued this same successor within the
      // window. encryptGraceSuccessor returns null when no key is configured →
      // grace disabled (revoke-on-reuse as before).
      const graceSuccessorCiphertext = await encryptGraceSuccessor(env, newRefreshToken);
      const graceExpiresAt = graceSuccessorCiphertext
        ? new Date(currentTime.getTime() + REFRESH_GRACE_TTL_MS)
        : null;

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
        graceSuccessorCiphertext,
        graceExpiresAt,
      });
      if (!rotated.ok) {
        // Lost the rotation race → the token was redeemed twice concurrently.
        // The winner stamped its successor + grace on this row; re-read and,
        // within the grace window, re-issue that successor idempotently rather
        // than revoking (otherwise this still revokes the family).
        const reread = await repo.getCliSessionByRefreshHash(refreshTokenHash);
        if (reread.ok) {
          return graceReplayOrRevoke(reread.value);
        }
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
        // Refresh preserves the session's TTL class: an MCP session keeps its
        // longer access-token lifetime across rotations.
        const refreshTtlMs = accessTtlFor(session.clientHost);
        access = await mintCliAccessToken(env, {
          sub: userPublicId(user.id),
          sessionId: cliSessionPublicId(newSessionId),
          orgIds: orgs.map((o) => o.id),
          ...workspaceIdsOf(orgs),
          now: currentTime,
          ...(refreshTtlMs !== undefined ? { ttlMs: refreshTtlMs } : {}),
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

    // --- OAuth 2.1 for MCP clients (saas-mcp-server MCP3) ---
    // An OAuth grant is a CLI-session-shaped session with a different client
    // label (risks R5: OP1 issuance reused — no second token plane). The
    // authorization code rides the OP1 grant table as a third flow, hashed
    // into cli_code_hash with the same single-use redeem semantics.

    /**
     * Console-called after user consent (POST /v1/auth/oauth2/authorize/complete).
     * Mints a single-use, short-TTL (~60s) authorization code bound to
     * (clientId, redirectUri, codeChallenge, user). The handler has already
     * enforced the allow-list + S256; this stores and audits.
     */
    async oauthAuthorizeComplete(
      input: OAuthAuthorizeCompleteInput,
    ): Promise<{ code: string; expiresAt: Date } | CliError> {
      const userResult = await repo.getUserById(input.approverUserUuid);
      if (!userResult.ok) return { error: "not_found", message: "User not found" };

      const code = generateOAuthAuthorizationCode();
      const codeHash = await hashSha256(code);
      const grantUuid = crypto.randomUUID();
      const currentTime = now();
      const expiresAt = new Date(currentTime.getTime() + OAUTH_CODE_TTL_MS);

      const created = await repo.createCliLoginGrant({
        id: grantUuid,
        flow: "oauth",
        cliCodeHash: codeHash,
        // The sessions list label: `mcp:<clientId>` (rendered as "<name> (MCP)").
        clientHost: `mcp:${input.clientId}`.slice(0, 128),
        oauthClientId: input.clientId,
        oauthRedirectUri: input.redirectUri,
        oauthCodeChallenge: input.codeChallenge,
        expiresAt,
        createdAt: currentTime,
      });
      if (!created.ok) return { error: "internal_error", message: "Failed to create authorization code" };

      // The user consented in the console — the grant is born approved. Reuses
      // the OP1 approve step so the redeem path (approved → redeemed, single
      // use, race-safe) is byte-for-byte the loopback one.
      const approved = await repo.approveCliLoginGrant(
        grantUuid,
        userPublicId(input.approverUserUuid),
        currentTime,
      );
      if (!approved.ok) return { error: "internal_error", message: "Failed to record consent" };

      await repo.recordSecurityEvent({
        ...eventBase(),
        eventType: "oauth.grant.created",
        outcome: "success",
        userId: input.approverUserUuid,
        metadata: { clientId: input.clientId, grantId: cliGrantPublicId(grantUuid) },
      });

      return { code, expiresAt };
    },

    /**
     * Token endpoint, grant_type=authorization_code. Verifies the code's
     * client/redirect binding + PKCE S256, then mints via the SAME OP1
     * issuance as a CLI login (short access JWT + rotating refresh + reuse
     * detection). A replayed code is `invalid_grant` AND revokes the session
     * family it minted (RFC 6749 §4.1.2 SHOULD-revoke, mirroring OP1's
     * refresh-reuse posture).
     */
    async oauthRedeemCode(input: OAuthRedeemCodeInput): Promise<CliSessionPayload | OAuthRedeemError> {
      const invalidGrant = (message: string): OAuthRedeemError => ({ error: "invalid_grant", message });

      const grantResult = await repo.getCliLoginGrantByCliCodeHash(await hashSha256(input.code));
      if (!grantResult.ok) return invalidGrant("Unknown or expired authorization code");
      const grant = grantResult.value;
      if (grant.flow !== "oauth") return invalidGrant("Unknown or expired authorization code");

      // Replay of an already-redeemed code: reject AND revoke the tokens it
      // minted (the stored session id points at generation 1 of the family).
      if (grant.status === "redeemed") {
        if (grant.sessionId) {
          const minted = await repo.getSessionById(grant.sessionId);
          if (minted.ok && minted.value.refreshFamilyId) {
            await repo.revokeCliFamily(minted.value.refreshFamilyId, "reuse_detected", now());
          }
        }
        await repo.recordSecurityEvent({
          ...eventBase(),
          eventType: "oauth.code.replay_detected",
          outcome: "failure",
          sessionId: grant.sessionId,
          metadata: { clientId: grant.oauthClientId, grantId: cliGrantPublicId(grant.id) },
        });
        return invalidGrant("Authorization code already used; tokens revoked");
      }
      if (grant.status !== "approved") return invalidGrant("Authorization code is no longer valid");
      if (grant.expiresAt.getTime() <= now().getTime()) {
        return invalidGrant("Authorization code expired");
      }

      // RFC 6749 §4.1.3 bindings: same client, same redirect_uri, and the
      // PKCE verifier must hash to the stored S256 challenge (RFC 7636 §4.6).
      if (grant.oauthClientId !== input.clientId) return invalidGrant("client_id mismatch");
      if (grant.oauthRedirectUri !== input.redirectUri) return invalidGrant("redirect_uri mismatch");
      const challenge = await computeS256Challenge(input.codeVerifier);
      if (!grant.oauthCodeChallenge || !challengeMatches(grant.oauthCodeChallenge, challenge)) {
        return invalidGrant("PKCE verification failed");
      }

      // Mint + single-use redeem via the shared OP1 path (race-safe: a
      // concurrent second redeem loses the conditional UPDATE).
      const redeemed = await this.redeemApprovedGrant(grant.id, grant.clientHost);
      if ("error" in redeemed) {
        if (redeemed.error === "expired" || redeemed.error === "not_found") {
          return invalidGrant("Authorization code already used or expired");
        }
        return { error: redeemed.error === "signing_unavailable" ? "signing_unavailable" : "internal_error", message: redeemed.message };
      }
      if (redeemed.kind !== "complete") return invalidGrant("Authorization code is not redeemable");
      return redeemed.session;
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

/**
 * The durable Workspace IDs (`ws_…`) for a session's orgs, positionally aligned
 * with `orgs.map(o => o.id)` so the `workspaceIds[]` token claim mirrors
 * `orgIds[]` (WID5). Returns undefined when membership returned no `workspaceRef`
 * at all (older payloads) so the optional claim is simply omitted; otherwise any
 * individually-missing ref is filled with "" to preserve index alignment.
 */
function workspaceIdsOf(orgs: CliSessionOrg[]): { workspaceIds: string[] } | Record<string, never> {
  if (!orgs.some((o) => typeof o.workspaceRef === "string" && o.workspaceRef.length > 0)) {
    return {};
  }
  return { workspaceIds: orgs.map((o) => o.workspaceRef ?? "") };
}

/** approved_by is stored as the public user id (`usr_<hex>`); decode to UUID. */
function parseCliApprover(approvedBy: string): string | null {
  if (!approvedBy.startsWith("usr_")) return null;
  // Reuse the canonical parse from ids: inline hex→uuid to avoid a cycle.
  const hex = approvedBy.slice(4);
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
