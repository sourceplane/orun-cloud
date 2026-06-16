import { createFakeRepository } from "./helpers/fake-repository";
import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}
if (typeof globalThis.crypto.randomUUID !== "function") {
  (globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = () => crypto.randomUUID();
}

import { createCliAuthService } from "../../../apps/identity-worker/src/services/cli-auth";
import type { Env } from "../../../apps/identity-worker/src/env";
import type { CliSessionOrg } from "@saas/contracts/auth";
import { asUuid } from "@saas/db";

const SIGNING_KEY = "x".repeat(48);

const USER_UUID = asUuid("11111111-1111-4111-8111-111111111111");
const USER_PUBLIC = "usr_" + "11111111111141118111111111111111";

function envWithKey(): Env {
  return {
    ENVIRONMENT: "test",
    DEBUG_DELIVERY: "false",
    CLI_JWT_SIGNING_KEY: SIGNING_KEY,
    CLI_CONSOLE_BASE_URL: "https://console.test",
  } as Env;
}

const ORGS: CliSessionOrg[] = [{ id: "org_" + "a".repeat(32), slug: "acme", name: "Acme", role: "admin" }];

function seedUser(repo: ReturnType<typeof createFakeRepository>): void {
  repo._users.set(USER_UUID, {
    id: USER_UUID,
    email: "dev@acme.test",
    emailLower: "dev@acme.test",
    displayName: "Dev",
    lastOrgSlug: null,
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
}

function makeService(repo: ReturnType<typeof createFakeRepository>, now: Date) {
  return createCliAuthService({
    repo,
    env: envWithKey(),
    now: () => now,
    fetchOrgs: async () => ORGS,
  });
}

// Reuse-grace (R11) is active only when an encryption key can be derived, i.e.
// OAUTH_STATE_SECRET is set. The default test env omits it (so the existing
// reuse-⇒-revoke tests keep that behavior); these helpers enable grace.
function envWithGrace(): Env {
  return { ...envWithKey(), OAUTH_STATE_SECRET: "g".repeat(48) } as Env;
}

function makeServiceGrace(repo: ReturnType<typeof createFakeRepository>, clock: () => Date) {
  return createCliAuthService({
    repo,
    env: envWithGrace(),
    now: clock,
    fetchOrgs: async () => ORGS,
  });
}

async function bootstrapSession(
  svc: ReturnType<typeof createCliAuthService>,
): Promise<{ refreshToken: string }> {
  const started = await svc.start(null);
  if ("error" in started) throw new Error("start failed");
  await svc.approveGrant(started.grantId, USER_UUID);
  const session = await svc.redeemCliCode(started.cliCode);
  if ("error" in session) throw new Error("redeem failed");
  return session;
}

describe("CLI auth service (OP1)", () => {
  const now = new Date("2026-06-14T12:00:00.000Z");

  describe("loopback grant: single-use + redeem", () => {
    it("start → approve → redeem yields a full session, and a second redeem fails", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      const svc = makeService(repo, now);

      const started = await svc.start("macbook");
      expect("error" in started).toBe(false);
      if ("error" in started) return;
      expect(started.authorizeUrl).toContain("https://console.test/cli/approve?grant=");
      expect(started.cliCode).toMatch(/^oclc_[0-9a-f]{64}$/);
      expect(repo._grants.size).toBe(1);

      // Cannot redeem before approval.
      const tooEarly = await svc.redeemCliCode(started.cliCode);
      expect("error" in tooEarly).toBe(true);

      // Console approves the grant.
      const approved = await svc.approveGrant(started.grantId, USER_UUID);
      expect("error" in approved).toBe(false);

      // First redeem mints a session.
      const redeemed = await svc.redeemCliCode(started.cliCode);
      expect("error" in redeemed).toBe(false);
      if ("error" in redeemed) return;
      expect(redeemed.accessToken.split(".")).toHaveLength(3);
      expect(redeemed.refreshToken).toMatch(/^ocrt_[0-9a-f]{64}$/);
      expect(redeemed.user.id).toBe(USER_PUBLIC);
      expect(redeemed.orgs).toEqual(ORGS);

      // A CLI session row now exists.
      const cliSessions = [...repo._sessions.values()].filter((s) => s.kind === "cli");
      expect(cliSessions).toHaveLength(1);
      expect(cliSessions[0]!.refreshGeneration).toBe(1);

      // Single-use: a replayed redeem of the same cli_code is rejected.
      const replay = await svc.redeemCliCode(started.cliCode);
      expect("error" in replay).toBe(true);
    });

    it("denied grant cannot be redeemed", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      const svc = makeService(repo, now);
      const started = await svc.start(null);
      if ("error" in started) throw new Error("start failed");
      await svc.denyGrant(started.grantId, USER_UUID);
      const redeemed = await svc.redeemCliCode(started.cliCode);
      expect("error" in redeemed).toBe(true);
    });
  });

  describe("device flow", () => {
    it("poll is pending until approval, then completes once", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      const svc = makeService(repo, now);

      const started = await svc.deviceStart("ci-runner");
      if ("error" in started) throw new Error("device start failed");
      expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(started.interval).toBeGreaterThan(0);

      const pending = await svc.devicePoll(started.deviceCode);
      expect(pending).toEqual({ kind: "pending" });

      // Approve via the human-entered user code.
      const lookup = await svc.getGrant({ userCode: started.userCode });
      if ("error" in lookup) throw new Error("lookup failed");
      await svc.approveGrant(lookup.publicId, USER_UUID);

      const complete = await svc.devicePoll(started.deviceCode);
      expect("kind" in complete && complete.kind === "complete").toBe(true);
      if (!("kind" in complete) || complete.kind !== "complete") return;
      expect(complete.session.accessToken.split(".")).toHaveLength(3);

      // A re-poll after redemption is rejected (single-use).
      const after = await svc.devicePoll(started.deviceCode);
      expect("error" in after).toBe(true);
    });
  });

  describe("reuse-grace interval (R11)", () => {
    it("re-issues the SAME successor on a replay within the grace window (no family revoke)", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      const svc = makeServiceGrace(repo, () => now); // fixed clock → replay is within the window
      const session = await bootstrapSession(svc);

      const rotated = await svc.refresh(session.refreshToken);
      if ("error" in rotated) throw new Error("rotate failed");

      // Replay the now-rotated token within the grace window: idempotent re-issue
      // of the SAME successor refresh token (fresh access JWT), NOT a revoke.
      const replay = await svc.refresh(session.refreshToken);
      expect("error" in replay).toBe(false);
      if ("error" in replay) return;
      expect(replay.refreshToken).toBe(rotated.refreshToken);

      // Family is intact: nothing revoked for reuse, and the successor still works.
      expect([...repo._sessions.values()].some((s) => s.revokedReason === "reuse_detected")).toBe(false);
      const next = await svc.refresh(rotated.refreshToken);
      expect("error" in next).toBe(false);
    });

    it("revokes the family when the replay arrives after the grace window", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      let clock = new Date("2026-06-14T12:00:00.000Z");
      const svc = makeServiceGrace(repo, () => clock);
      const session = await bootstrapSession(svc);

      const rotated = await svc.refresh(session.refreshToken);
      if ("error" in rotated) throw new Error("rotate failed");

      // Advance past the ~10s grace window → a replay is genuine reuse.
      clock = new Date(clock.getTime() + 11 * 1000);
      const replay = await svc.refresh(session.refreshToken);
      expect("error" in replay).toBe(true);
      expect([...repo._sessions.values()].some((s) => s.revokedReason === "reuse_detected")).toBe(true);
    });

    it("never grace-replays a token revoked for cause (e.g. logout)", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      const svc = makeServiceGrace(repo, () => now);
      const session = await bootstrapSession(svc);

      await svc.revoke(session.refreshToken); // family revoked with reason 'logout', not 'superseded'
      const replay = await svc.refresh(session.refreshToken);
      expect("error" in replay).toBe(true);
    });
  });

  describe("rotating refresh: reuse ⇒ family revoke", () => {
    it("rotates on the live token and kills the family when an old token is reused", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      const svc = makeService(repo, now);

      // Bootstrap a session via loopback.
      const started = await svc.start(null);
      if ("error" in started) throw new Error("start failed");
      await svc.approveGrant(started.grantId, USER_UUID);
      const session = await svc.redeemCliCode(started.cliCode);
      if ("error" in session) throw new Error("redeem failed");

      const firstRefresh = session.refreshToken;

      // Rotate once with the live refresh token → new pair.
      const rotated = await svc.refresh(firstRefresh);
      expect("error" in rotated).toBe(false);
      if ("error" in rotated) return;
      expect(rotated.refreshToken).not.toBe(firstRefresh);

      // Reusing the FIRST (now-rotated) refresh token must fail AND revoke family.
      const reuse = await svc.refresh(firstRefresh);
      expect("error" in reuse).toBe(true);

      // After reuse detection, even the (previously live) second token is dead:
      // the whole family is revoked, so the legitimate holder is locked out.
      const familyId = [...repo._sessions.values()][0]!.refreshFamilyId!;
      const familyRows = [...repo._sessions.values()].filter((s) => s.refreshFamilyId === familyId);
      expect(familyRows.every((s) => s.revokedAt !== null)).toBe(true);
      expect(familyRows.some((s) => s.revokedReason === "reuse_detected")).toBe(true);

      const afterReuse = await svc.refresh(rotated.refreshToken);
      expect("error" in afterReuse).toBe(true);
    });

    it("slides the refresh-token expiry forward on each refresh (active sessions stay alive)", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      // Mutable clock so we can advance time between mint and refresh.
      let clock = new Date("2026-06-14T12:00:00.000Z");
      const svc = createCliAuthService({
        repo,
        env: envWithKey(),
        now: () => clock,
        fetchOrgs: async () => ORGS,
      });

      const started = await svc.start(null);
      if ("error" in started) throw new Error("start failed");
      await svc.approveGrant(started.grantId, USER_UUID);
      const session = await svc.redeemCliCode(started.cliCode);
      if ("error" in session) throw new Error("redeem failed");

      const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
      const mintedAt = clock.getTime();

      // Use the session 10 days later — well before the original 30-day expiry.
      const tenDays = 10 * 24 * 60 * 60 * 1000;
      clock = new Date(mintedAt + tenDays);
      const rotated = await svc.refresh(session.refreshToken);
      expect("error" in rotated).toBe(false);
      if ("error" in rotated) return;

      // The new live generation's refresh expiry must slide to now + TTL, not
      // remain anchored at the original mint + TTL.
      const live = [...repo._sessions.values()].find(
        (s) => s.kind === "cli" && s.replacedBy === null && s.revokedAt === null,
      );
      expect(live).toBeDefined();
      expect(live!.refreshExpiresAt!.getTime()).toBe(clock.getTime() + REFRESH_TTL_MS);
      // And that is strictly later than the original anchor (proves it slid).
      expect(live!.refreshExpiresAt!.getTime()).toBeGreaterThan(mintedAt + REFRESH_TTL_MS);
    });

    it("enforces an absolute lifetime cap even for a continuously-active family", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      let clock = new Date("2026-06-14T12:00:00.000Z");
      const svc = createCliAuthService({
        repo,
        env: envWithKey(),
        now: () => clock,
        fetchOrgs: async () => ORGS,
      });

      const started = await svc.start(null);
      if ("error" in started) throw new Error("start failed");
      await svc.approveGrant(started.grantId, USER_UUID);
      const session = await svc.redeemCliCode(started.cliCode);
      if ("error" in session) throw new Error("redeem failed");
      const mintedAt = clock.getTime();

      const ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
      const day = 24 * 60 * 60 * 1000;

      // Refresh actively every ~20 days. The sliding window keeps it alive...
      let token = session.refreshToken;
      for (const offsetDays of [20, 40, 60, 80]) {
        clock = new Date(mintedAt + offsetDays * day);
        const r = await svc.refresh(token);
        expect("error" in r).toBe(false);
        if ("error" in r) return;
        token = r.refreshToken;
      }

      // ...until the family crosses its absolute cap (~90 days from FIRST login),
      // at which point even the live token is rejected and the family retired.
      clock = new Date(mintedAt + ABSOLUTE_TTL_MS + 1000);
      const capped = await svc.refresh(token);
      expect("error" in capped).toBe(true);
      if (!("error" in capped)) return;
      expect(capped.error).toBe("expired");

      const familyId = [...repo._sessions.values()][0]!.refreshFamilyId!;
      const familyRows = [...repo._sessions.values()].filter((s) => s.refreshFamilyId === familyId);
      expect(familyRows.every((s) => s.revokedAt !== null)).toBe(true);
      expect(familyRows.some((s) => s.revokedReason === "absolute_expiry")).toBe(true);
    });

    it("clamps the slid refresh expiry at the absolute deadline near end-of-life", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      let clock = new Date("2026-06-14T12:00:00.000Z");
      const svc = createCliAuthService({
        repo,
        env: envWithKey(),
        now: () => clock,
        fetchOrgs: async () => ORGS,
      });

      const started = await svc.start(null);
      if ("error" in started) throw new Error("start failed");
      await svc.approveGrant(started.grantId, USER_UUID);
      const session = await svc.redeemCliCode(started.cliCode);
      if ("error" in session) throw new Error("redeem failed");
      const mintedAt = clock.getTime();

      const ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
      const day = 24 * 60 * 60 * 1000;

      // Keep the session active (refresh strictly within each 30-day idle
      // window — gaps 20/25/25 days) up to day 70.
      let token = session.refreshToken;
      for (const offsetDays of [20, 45, 70]) {
        clock = new Date(mintedAt + offsetDays * day);
        const r = await svc.refresh(token);
        expect("error" in r).toBe(false);
        if ("error" in r) return;
        token = r.refreshToken;
      }

      // At day 70 the slid window (now + 30d = day 100) overshoots the 90-day
      // cap, so the new expiry must be clamped to mintedAt + ABSOLUTE_TTL_MS.
      const live = [...repo._sessions.values()].find(
        (s) => s.kind === "cli" && s.replacedBy === null && s.revokedAt === null,
      );
      expect(live).toBeDefined();
      expect(live!.refreshExpiresAt!.getTime()).toBe(mintedAt + ABSOLUTE_TTL_MS);
    });

    it("revoke kills the session family (logout)", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      const svc = makeService(repo, now);
      const started = await svc.start(null);
      if ("error" in started) throw new Error("start failed");
      await svc.approveGrant(started.grantId, USER_UUID);
      const session = await svc.redeemCliCode(started.cliCode);
      if ("error" in session) throw new Error("redeem failed");

      const revoked = await svc.revoke(session.refreshToken);
      expect("error" in revoked).toBe(false);

      // The refresh no longer works.
      const afterRevoke = await svc.refresh(session.refreshToken);
      expect("error" in afterRevoke).toBe(true);
    });
  });

  describe("console session management", () => {
    it("lists and revokes the user's CLI sessions", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      const svc = makeService(repo, now);
      const started = await svc.start("laptop");
      if ("error" in started) throw new Error("start failed");
      await svc.approveGrant(started.grantId, USER_UUID);
      await svc.redeemCliCode(started.cliCode);

      const listed = await svc.listSessions(USER_UUID);
      expect(Array.isArray(listed)).toBe(true);
      if (!Array.isArray(listed)) return;
      expect(listed).toHaveLength(1);
      expect(listed[0]!.clientHost).toBe("laptop");

      const sessionPublicId = (await import("../../../apps/identity-worker/src/cli/secrets")).cliSessionPublicId(
        listed[0]!.id,
      );
      const revoked = await svc.revokeSessionById(USER_UUID, sessionPublicId);
      expect("error" in revoked).toBe(false);

      // Another user cannot revoke it.
      const otherUser = asUuid("22222222-2222-4222-8222-222222222222");
      const denied = await svc.revokeSessionById(otherUser, sessionPublicId);
      expect("error" in denied).toBe(true);
    });
  });

  describe("signing key discipline", () => {
    it("fails to mint a session when the signing key is unavailable", async () => {
      const repo = createFakeRepository();
      seedUser(repo);
      const svc = createCliAuthService({
        repo,
        env: { ENVIRONMENT: "test", DEBUG_DELIVERY: "false" } as Env, // no CLI_JWT_SIGNING_KEY
        now: () => now,
        fetchOrgs: async () => ORGS,
      });
      const started = await svc.start(null);
      if ("error" in started) throw new Error("start failed");
      await svc.approveGrant(started.grantId, USER_UUID);
      const redeemed = await svc.redeemCliCode(started.cliCode);
      expect("error" in redeemed).toBe(true);
      if (!("error" in redeemed)) return;
      expect(redeemed.error).toBe("signing_unavailable");
    });
  });
});
