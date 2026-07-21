/// <reference types="@cloudflare/workers-types" />
// OAuth 2.1 for MCP clients (saas-mcp-server MCP3) — service + handler tests,
// mirroring cli-auth-service.test.ts. The invariants under test:
//   - vetted public-client allow-list (D1 Option A): unknown client_id and
//     unregistered redirect_uri are rejected; loopback URIs match on any port
//     (RFC 8252 §7.3); the user agent is never redirected to an unknown URI.
//   - PKCE S256 mandatory: challenge shape enforced at authorize; verifier
//     verified at token; bad verifier ⇒ invalid_grant.
//   - authorization codes are single-use + short-TTL; replay ⇒ invalid_grant
//     AND revocation of the session family the code minted (RFC 6749 §4.1.2).
//   - OP1 reuse (risks R5): the minted session IS a cli-kind session (rotating
//     refresh, reuse detection, console revocation) labeled `mcp:<clientId>`.

import { createFakeRepository } from "./helpers/fake-repository";
import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}
if (typeof globalThis.crypto.randomUUID !== "function") {
  (globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = () => crypto.randomUUID();
}

import { createCliAuthService } from "../../../apps/identity-worker/src/services/cli-auth";
import {
  handleOAuth2AuthorizationServerMetadata,
  handleOAuth2AuthorizeComplete,
  handleOAuth2Token,
} from "../../../apps/identity-worker/src/handlers/oauth2";
import { computeS256Challenge } from "../../../apps/identity-worker/src/oauth2/pkce";
import { verifyCliAccessToken } from "../../../apps/identity-worker/src/cli/jwt";
import type { Env } from "../../../apps/identity-worker/src/env";
import type { CliSessionOrg } from "@saas/contracts/auth";
import { asUuid } from "@saas/db";

const SIGNING_KEY = "x".repeat(48);
const USER_UUID = asUuid("11111111-1111-4111-8111-111111111111");
const USER_PUBLIC = "usr_" + "11111111111141118111111111111111";

// A valid RFC 7636 verifier (43+ unreserved chars) used throughout.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

const ORGS: CliSessionOrg[] = [
  { id: "org_" + "a".repeat(32), workspaceRef: "ws_3KF9TQ2P", slug: "acme", name: "Acme", role: "admin" },
];

function envWithKey(): Env {
  return {
    ENVIRONMENT: "test",
    DEBUG_DELIVERY: "false",
    CLI_JWT_SIGNING_KEY: SIGNING_KEY,
    CLI_CONSOLE_BASE_URL: "https://console.test",
    OAUTH_REDIRECT_BASE_URL: "https://api.test",
  } as Env;
}

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

function makeService(repo: ReturnType<typeof createFakeRepository>, clock: () => Date) {
  return createCliAuthService({
    repo,
    env: envWithKey(),
    now: clock,
    fetchOrgs: async () => ORGS,
  });
}

async function authorize(
  svc: ReturnType<typeof createCliAuthService>,
  overrides: Partial<{ clientId: string; redirectUri: string; codeChallenge: string }> = {},
): Promise<{ code: string; expiresAt: Date }> {
  const r = await svc.oauthAuthorizeComplete({
    clientId: overrides.clientId ?? "claude-web",
    redirectUri: overrides.redirectUri ?? "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: overrides.codeChallenge ?? (await computeS256Challenge(VERIFIER)),
    approverUserUuid: USER_UUID,
  });
  if ("error" in r) throw new Error(`authorize failed: ${r.message}`);
  return r;
}

describe("OAuth 2.1 service (MCP3, riding OP1)", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");

  it("authorize → token mints an OP1-shaped session labeled mcp:<clientId>", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const svc = makeService(repo, () => now);

    const { code, expiresAt } = await authorize(svc);
    expect(code).toMatch(/^ocac_[0-9a-f]{64}$/);
    // Short TTL (~60s), single-use.
    expect(expiresAt.getTime() - now.getTime()).toBe(60_000);
    // Grant created + consent recorded.
    expect(repo._securityEvents.map((e) => e.eventType)).toContain("oauth.grant.created");

    const session = await svc.oauthRedeemCode({
      code,
      clientId: "claude-web",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeVerifier: VERIFIER,
    });
    expect("error" in session).toBe(false);
    if ("error" in session) return;

    // Same payload shape + token plane as a CLI login (R5).
    expect(session.accessToken.split(".")).toHaveLength(3);
    expect(session.refreshToken).toMatch(/^ocrt_[0-9a-f]{64}$/);
    expect(session.user.id).toBe(USER_PUBLIC);
    const claims = await verifyCliAccessToken(envWithKey(), session.accessToken, now);
    expect(claims!.actorKind).toBe("user");
    expect(claims!.orgIds).toEqual(ORGS.map((o) => o.id));

    // The minted session is cli-kind with the mcp client label — it shows up
    // in the existing "Sessions & devices" list with no new surface.
    const cliSessions = [...repo._sessions.values()].filter((s) => s.kind === "cli");
    expect(cliSessions).toHaveLength(1);
    expect(cliSessions[0]!.clientHost).toBe("mcp:claude-web");

    const listed = await svc.listSessions(USER_UUID);
    expect(Array.isArray(listed) && listed.length).toBe(1);
  });

  it("rejects a wrong PKCE verifier with invalid_grant (and the right one still works)", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const svc = makeService(repo, () => now);
    const { code } = await authorize(svc);

    const bad = await svc.oauthRedeemCode({
      code,
      clientId: "claude-web",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeVerifier: "wrong-verifier-wrong-verifier-wrong-verifier-wrong",
    });
    expect("error" in bad && bad.error).toBe("invalid_grant");

    const good = await svc.oauthRedeemCode({
      code,
      clientId: "claude-web",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeVerifier: VERIFIER,
    });
    expect("error" in good).toBe(false);
  });

  it("rejects client_id / redirect_uri mismatches with invalid_grant", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const svc = makeService(repo, () => now);
    const { code } = await authorize(svc);

    const wrongClient = await svc.oauthRedeemCode({
      code,
      clientId: "cursor",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeVerifier: VERIFIER,
    });
    expect("error" in wrongClient && wrongClient.error).toBe("invalid_grant");

    const wrongRedirect = await svc.oauthRedeemCode({
      code,
      clientId: "claude-web",
      redirectUri: "https://claude.com/api/mcp/auth_callback",
      codeVerifier: VERIFIER,
    });
    expect("error" in wrongRedirect && wrongRedirect.error).toBe("invalid_grant");
  });

  it("codes are single-use: replay is invalid_grant AND revokes the minted family", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const svc = makeService(repo, () => now);
    const { code } = await authorize(svc);

    const redeem = { code, clientId: "claude-web", redirectUri: "https://claude.ai/api/mcp/auth_callback", codeVerifier: VERIFIER };
    const first = await svc.oauthRedeemCode(redeem);
    expect("error" in first).toBe(false);

    const replay = await svc.oauthRedeemCode(redeem);
    expect("error" in replay && replay.error).toBe("invalid_grant");

    // RFC 6749 §4.1.2 SHOULD-revoke: the session the code minted is dead.
    const cliSessions = [...repo._sessions.values()].filter((s) => s.kind === "cli");
    expect(cliSessions).toHaveLength(1);
    expect(cliSessions[0]!.revokedAt).not.toBeNull();
    expect(cliSessions[0]!.revokedReason).toBe("reuse_detected");
    expect(repo._securityEvents.map((e) => e.eventType)).toContain("oauth.code.replay_detected");
  });

  it("codes expire after their ~60s TTL", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    let current = now;
    const svc = makeService(repo, () => current);
    const { code } = await authorize(svc);

    current = new Date(now.getTime() + 61_000);
    const late = await svc.oauthRedeemCode({
      code,
      clientId: "claude-web",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeVerifier: VERIFIER,
    });
    expect("error" in late && late.error).toBe("invalid_grant");
  });

  it("refresh rotates via the unchanged OP1 path, and reuse revokes the family", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    let current = now;
    const svc = makeService(repo, () => current);
    const { code } = await authorize(svc);
    const session = await svc.oauthRedeemCode({
      code,
      clientId: "claude-web",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeVerifier: VERIFIER,
    });
    if ("error" in session) throw new Error("redeem failed");

    current = new Date(current.getTime() + 60_000);
    const rotated = await svc.refresh(session.refreshToken);
    expect("error" in rotated).toBe(false);
    if ("error" in rotated) return;
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
    // The rotated generation keeps the mcp client label.
    const live = [...repo._sessions.values()].find((s) => s.kind === "cli" && s.revokedAt === null);
    expect(live!.clientHost).toBe("mcp:claude-web");

    // Reuse of the spent refresh token (outside any grace) revokes the family.
    current = new Date(current.getTime() + 60_000);
    const reuse = await svc.refresh(session.refreshToken);
    expect("error" in reuse).toBe(true);
    const stillLive = [...repo._sessions.values()].filter((s) => s.kind === "cli" && s.revokedAt === null);
    expect(stillLive).toHaveLength(0);
  });

  it("console revocation kills an MCP grant through the existing session path, unchanged", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const svc = makeService(repo, () => now);
    const { code } = await authorize(svc);
    const session = await svc.oauthRedeemCode({
      code,
      clientId: "claude-web",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeVerifier: VERIFIER,
    });
    if ("error" in session) throw new Error("redeem failed");

    const listed = await svc.listSessions(USER_UUID);
    if (!Array.isArray(listed)) throw new Error("list failed");
    const { cliSessionPublicId } = await import("../../../apps/identity-worker/src/cli/secrets");
    const revoked = await svc.revokeSessionById(USER_UUID, cliSessionPublicId(listed[0]!.id));
    expect("error" in revoked).toBe(false);

    // The refresh token is now dead.
    const after = await svc.refresh(session.refreshToken);
    expect("error" in after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function deps(repo: ReturnType<typeof createFakeRepository>) {
  return { repo, fetchOrgs: async () => ORGS };
}

function actorHeaders(): Record<string, string> {
  return {
    "x-actor-subject-id": USER_PUBLIC,
    "x-actor-subject-type": "user",
    "content-type": "application/json",
  };
}

function authorizeCompleteRequest(body: unknown, headers: Record<string, string> = actorHeaders()): Request {
  return new Request("https://identity.internal/v1/auth/oauth2/authorize/complete", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function tokenRequest(params: Record<string, string>): Request {
  return new Request("https://identity.internal/v1/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

describe("GET /.well-known/oauth-authorization-server (RFC 8414)", () => {
  it("serves raw metadata: issuer, console authorize URL, S256, public clients", async () => {
    const res = handleOAuth2AuthorizationServerMetadata(envWithKey(), "req_md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      issuer: "https://api.test",
      authorization_endpoint: "https://console.test/oauth/authorize",
      token_endpoint: "https://api.test/v1/auth/oauth2/token",
      // MCP11 leg B: RFC 7591 DCR — claude.ai's connector flow requires this.
      registration_endpoint: "https://api.test/v1/auth/oauth2/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    // Raw spec JSON — no platform envelope.
    expect(body["data"]).toBeUndefined();
  });

  it("503s when the issuer base URL is not configured", async () => {
    const env = { ...envWithKey(), OAUTH_REDIRECT_BASE_URL: "" } as Env;
    const res = handleOAuth2AuthorizationServerMetadata(env, "req_md2");
    expect(res.status).toBe(503);
  });
});

describe("POST /v1/auth/oauth2/authorize/complete", () => {
  it("mints a code for a vetted client (201, platform envelope)", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const res = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId: "claude-web",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeChallenge: await computeS256Challenge(VERIFIER),
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_ac1",
      deps(repo),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { code: string; expiresAt: string } };
    expect(body.data.code).toMatch(/^ocac_/);
    expect(Date.parse(body.data.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("401s without actor headers (api-edge injects them for session callers only)", async () => {
    const repo = createFakeRepository();
    const res = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({}, { "content-type": "application/json" }),
      envWithKey(),
      "req_ac2",
      deps(repo),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an unknown client_id (allow-list, D1 Option A)", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const res = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId: "evil-client",
        redirectUri: "https://evil.example/callback",
        codeChallenge: await computeS256Challenge(VERIFIER),
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_ac3",
      deps(repo),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: { fields: Record<string, string[]> } } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.fields["clientId"]).toBeDefined();
    expect(repo._grants.size).toBe(0);
  });

  it("rejects a redirect_uri not registered for the client", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const res = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId: "claude-web",
        redirectUri: "https://attacker.example/api/mcp/auth_callback",
        codeChallenge: await computeS256Challenge(VERIFIER),
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_ac4",
      deps(repo),
    );
    expect(res.status).toBe(422);
    expect(repo._grants.size).toBe(0);
  });

  it("requires S256 (plain is rejected) and a well-formed challenge", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const plain = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId: "claude-web",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeChallenge: VERIFIER,
        codeChallengeMethod: "plain",
      }),
      envWithKey(),
      "req_ac5",
      deps(repo),
    );
    expect(plain.status).toBe(422);

    const malformed = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId: "claude-web",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeChallenge: "too-short",
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_ac6",
      deps(repo),
    );
    expect(malformed.status).toBe(422);
    expect(repo._grants.size).toBe(0);
  });

  it("accepts a loopback redirect on ANY port for loopback-registered clients (RFC 8252 §7.3)", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const res = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId: "orun-cloud-dev",
        redirectUri: "http://127.0.0.1:53123/callback",
        codeChallenge: await computeS256Challenge(VERIFIER),
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_ac7",
      deps(repo),
    );
    expect(res.status).toBe(201);
  });
});

describe("POST /v1/auth/oauth2/token (RFC 6749)", () => {
  async function mintCode(repo: ReturnType<typeof createFakeRepository>, redirectUri = "https://claude.ai/api/mcp/auth_callback", clientId = "claude-web"): Promise<string> {
    const res = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId,
        redirectUri,
        codeChallenge: await computeS256Challenge(VERIFIER),
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_mint",
      deps(repo),
    );
    const body = (await res.json()) as { data: { code: string } };
    return body.data.code;
  }

  it("exchanges a code (form-encoded) for a raw OAuth token response, no-store", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const code = await mintCode(repo);

    const res = await handleOAuth2Token(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "claude-web",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: VERIFIER,
      }),
      envWithKey(),
      "req_tk1",
      deps(repo),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    // RFC 6749 §5.1 shape — NOT the platform envelope.
    expect(body["token_type"]).toBe("Bearer");
    expect(String(body["access_token"]).split(".")).toHaveLength(3);
    expect(body["refresh_token"]).toMatch(/^ocrt_/);
    // MCP OAuth sessions get the prolonged 8h access-token TTL (clientHost is
    // `mcp:claude-web`), NOT the short 15m CLI default — so a connector doesn't
    // force a browser re-auth every 15 minutes.
    const expiresIn = body["expires_in"] as number;
    expect(expiresIn).toBeGreaterThan(8 * 60 * 60 - 120); // ~8h, minus tiny elapsed
    expect(expiresIn).toBeLessThanOrEqual(8 * 60 * 60);
    expect(body["data"]).toBeUndefined();
  });

  it("replayed code → invalid_grant (400) and the first grant's tokens are revoked", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const code = await mintCode(repo);
    const params = {
      grant_type: "authorization_code",
      code,
      client_id: "claude-web",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_verifier: VERIFIER,
    };
    const first = await handleOAuth2Token(tokenRequest(params), envWithKey(), "req_tk2", deps(repo));
    expect(first.status).toBe(200);

    const replay = await handleOAuth2Token(tokenRequest(params), envWithKey(), "req_tk3", deps(repo));
    expect(replay.status).toBe(400);
    const body = (await replay.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
    const live = [...repo._sessions.values()].filter((s) => s.kind === "cli" && s.revokedAt === null);
    expect(live).toHaveLength(0);
  });

  it("bad PKCE verifier → invalid_grant", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const code = await mintCode(repo);
    const res = await handleOAuth2Token(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "claude-web",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: "not-the-right-verifier-not-the-right-verifier-x",
      }),
      envWithKey(),
      "req_tk4",
      deps(repo),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("unknown client_id → invalid_client (401); unregistered redirect → invalid_grant", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const code = await mintCode(repo);

    const unknown = await handleOAuth2Token(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "evil-client",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: VERIFIER,
      }),
      envWithKey(),
      "req_tk5",
      deps(repo),
    );
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: string }).error).toBe("invalid_client");

    const badRedirect = await handleOAuth2Token(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "claude-web",
        redirect_uri: "https://attacker.example/cb",
        code_verifier: VERIFIER,
      }),
      envWithKey(),
      "req_tk6",
      deps(repo),
    );
    expect(badRedirect.status).toBe(400);
    expect(((await badRedirect.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("missing params → invalid_request; unknown grant_type → unsupported_grant_type", async () => {
    const repo = createFakeRepository();
    const missing = await handleOAuth2Token(
      tokenRequest({ grant_type: "authorization_code", code: "ocac_x" }),
      envWithKey(),
      "req_tk7",
      deps(repo),
    );
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe("invalid_request");

    const unsupported = await handleOAuth2Token(
      tokenRequest({ grant_type: "password" }),
      envWithKey(),
      "req_tk8",
      deps(repo),
    );
    expect(unsupported.status).toBe(400);
    expect(((await unsupported.json()) as { error: string }).error).toBe("unsupported_grant_type");
  });

  it("loopback client: token exchange must present the SAME port authorize bound", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const code = await mintCode(repo, "http://127.0.0.1:53123/callback", "orun-cloud-dev");

    // Different (also-loopback) port ≠ the bound redirect_uri → invalid_grant.
    const wrongPort = await handleOAuth2Token(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "orun-cloud-dev",
        redirect_uri: "http://127.0.0.1:60000/callback",
        code_verifier: VERIFIER,
      }),
      envWithKey(),
      "req_tk9",
      deps(repo),
    );
    expect(wrongPort.status).toBe(400);

    const samePort = await handleOAuth2Token(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "orun-cloud-dev",
        redirect_uri: "http://127.0.0.1:53123/callback",
        code_verifier: VERIFIER,
      }),
      envWithKey(),
      "req_tk10",
      deps(repo),
    );
    expect(samePort.status).toBe(200);
  });

  it("grant_type=refresh_token rotates via OP1 and rejects unknown tokens with invalid_grant", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const code = await mintCode(repo);
    const first = await handleOAuth2Token(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "claude-web",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: VERIFIER,
      }),
      envWithKey(),
      "req_tk11",
      deps(repo),
    );
    const minted = (await first.json()) as { refresh_token: string };

    const rotated = await handleOAuth2Token(
      tokenRequest({ grant_type: "refresh_token", refresh_token: minted.refresh_token }),
      envWithKey(),
      "req_tk12",
      deps(repo),
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as { refresh_token: string; access_token: string };
    expect(rotatedBody.refresh_token).not.toBe(minted.refresh_token);

    const bogus = await handleOAuth2Token(
      tokenRequest({ grant_type: "refresh_token", refresh_token: "ocrt_" + "0".repeat(64) }),
      envWithKey(),
      "req_tk13",
      deps(repo),
    );
    expect(bogus.status).toBe(400);
    expect(((await bogus.json()) as { error: string }).error).toBe("invalid_grant");
  });
});
