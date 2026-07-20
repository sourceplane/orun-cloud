/// <reference types="@cloudflare/workers-types" />
// RFC 7591 Dynamic Client Registration (saas-mcp-server MCP11 leg B — D1 →
// Option B activated on its documented path), mirroring oauth2.test.ts.
// The invariants under test:
//   - registration mints PUBLIC clients only (`dcr_<hex32>` ids, NO
//     client_secret ever; auth method must be absent or "none") — R5 holds:
//     clients, not tokens;
//   - metadata validation per RFC 7591 §3.2.2 (invalid_client_metadata /
//     invalid_redirect_uri raw error bodies, no platform envelope);
//   - redirect URIs: https non-loopback OR http loopback (RFC 8252 §7.3);
//   - static-first resolution: a dynamic row can never shadow a vetted
//     clientId, and expired registrations resolve as unknown clients;
//   - the full dynamic flow rides the UNCHANGED MCP3 endpoints (authorize/
//     complete → token with PKCE → OP1 session), touching last_used_at and
//     pushing the unused-client GC horizon forward on redemption;
//   - unused-client GC is opportunistic on registration writes (bounded).

import { createFakeRepository } from "./helpers/fake-repository";
import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}
if (typeof globalThis.crypto.randomUUID !== "function") {
  (globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = () => crypto.randomUUID();
}

import {
  handleOAuth2Register,
  handleOAuth2ClientInfo,
  handleOAuth2AuthorizeComplete,
  handleOAuth2Token,
} from "../../../apps/identity-worker/src/handlers/oauth2";
import { computeS256Challenge } from "../../../apps/identity-worker/src/oauth2/pkce";
import {
  resolveOAuthClient,
  OAUTH_DYNAMIC_CLIENT_TTL_MS,
} from "../../../apps/identity-worker/src/oauth2/clients";
import type { Env } from "../../../apps/identity-worker/src/env";
import type { CliSessionOrg } from "@saas/contracts/auth";
import { asUuid } from "@saas/db";

const SIGNING_KEY = "x".repeat(48);
const USER_UUID = asUuid("11111111-1111-4111-8111-111111111111");
const USER_PUBLIC = "usr_" + "11111111111141118111111111111111";
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

function deps(repo: ReturnType<typeof createFakeRepository>) {
  return { repo, fetchOrgs: async () => ORGS };
}

function registerRequest(body: unknown): Request {
  return new Request("https://identity.internal/v1/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function clientInfoRequest(clientId: string): Request {
  return new Request(`https://identity.internal/v1/auth/oauth2/client/${encodeURIComponent(clientId)}`, {
    method: "GET",
  });
}

function actorHeaders(): Record<string, string> {
  return {
    "x-actor-subject-id": USER_PUBLIC,
    "x-actor-subject-type": "user",
    "content-type": "application/json",
  };
}

function authorizeCompleteRequest(body: unknown): Request {
  return new Request("https://identity.internal/v1/auth/oauth2/authorize/complete", {
    method: "POST",
    headers: actorHeaders(),
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

const GOOD_REGISTRATION = {
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/api/organizations/x/mcp/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
};

async function register(
  repo: ReturnType<typeof createFakeRepository>,
  body: unknown = GOOD_REGISTRATION,
): Promise<{ res: Response; body: Record<string, unknown> }> {
  const res = await handleOAuth2Register(registerRequest(body), envWithKey(), "req_reg", deps(repo));
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /v1/auth/oauth2/register (RFC 7591)", () => {
  it("201: mints a dcr_ public client — raw RFC 7591 JSON, no secret, no envelope, no-store", async () => {
    const repo = createFakeRepository();
    const { res, body } = await register(repo);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");

    expect(body["client_id"]).toMatch(/^dcr_[0-9a-f]{32}$/);
    expect(body["client_name"]).toBe("Claude");
    expect(body["redirect_uris"]).toEqual(GOOD_REGISTRATION.redirect_uris);
    expect(body["token_endpoint_auth_method"]).toBe("none");
    expect(body["grant_types"]).toEqual(["authorization_code", "refresh_token"]);
    expect(body["response_types"]).toEqual(["code"]);
    expect(typeof body["client_id_issued_at"]).toBe("number");
    // Public clients ONLY: no secret is ever minted, and no platform envelope.
    expect(body["client_secret"]).toBeUndefined();
    expect(body["client_secret_expires_at"]).toBeUndefined();
    expect(body["data"]).toBeUndefined();

    // Row persisted with the 30d unused-client GC horizon; not yet used.
    const row = repo._dynamicClients.get(body["client_id"] as string)!;
    expect(row).toBeDefined();
    expect(row.lastUsedAt).toBeNull();
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(OAUTH_DYNAMIC_CLIENT_TTL_MS);

    // Audited — clientId + name + URI COUNT only (URIs stay out of the event).
    const event = repo._securityEvents.find((e) => e.eventType === "oauth.client.registered")!;
    expect(event).toBeDefined();
    expect(event.outcome).toBe("success");
    expect(event.metadata["clientId"]).toBe(body["client_id"]);
    expect(event.metadata["redirectUriCount"]).toBe(1);
    expect(JSON.stringify(event.metadata)).not.toContain("claude.ai");
  });

  it("accepts a minimal registration (name + redirect_uris only; defaults applied)", async () => {
    const repo = createFakeRepository();
    const { res, body } = await register(repo, {
      client_name: "Minimal",
      redirect_uris: ["https://example.com/cb"],
    });
    expect(res.status).toBe(201);
    expect(body["token_endpoint_auth_method"]).toBe("none");
    expect(body["grant_types"]).toEqual(["authorization_code", "refresh_token"]);
  });

  it("accepts http loopback redirect URIs (RFC 8252 §7.3)", async () => {
    const repo = createFakeRepository();
    const { res } = await register(repo, {
      client_name: "Local dev",
      redirect_uris: ["http://127.0.0.1:49152/callback", "http://localhost/cb"],
    });
    expect(res.status).toBe(201);
  });

  it("rejects confidential clients: any auth method but none → invalid_client_metadata", async () => {
    const repo = createFakeRepository();
    for (const method of ["client_secret_basic", "client_secret_post", "private_key_jwt"]) {
      const { res, body } = await register(repo, { ...GOOD_REGISTRATION, token_endpoint_auth_method: method });
      expect(res.status).toBe(400);
      expect(body["error"]).toBe("invalid_client_metadata");
    }
    const { res, body } = await register(repo, { ...GOOD_REGISTRATION, client_secret: "shhh" });
    expect(res.status).toBe(400);
    expect(body["error"]).toBe("invalid_client_metadata");
    expect(repo._dynamicClients.size).toBe(0);
  });

  it("rejects a caller-chosen client_id (ids are server-minted; static shadowing impossible)", async () => {
    const repo = createFakeRepository();
    for (const chosen of ["claude-web", "dcr_" + "a".repeat(32), "my-client"]) {
      const { res, body } = await register(repo, { ...GOOD_REGISTRATION, client_id: chosen });
      expect(res.status).toBe(400);
      expect(body["error"]).toBe("invalid_client_metadata");
    }
    expect(repo._dynamicClients.size).toBe(0);
  });

  it("rejects a missing/empty/over-long client_name", async () => {
    const repo = createFakeRepository();
    for (const client_name of [undefined, "", "   ", "x".repeat(101)]) {
      const { res, body } = await register(repo, { ...GOOD_REGISTRATION, client_name });
      expect(res.status).toBe(400);
      expect(body["error"]).toBe("invalid_client_metadata");
    }
  });

  it("rejects grant/response types outside the supported set", async () => {
    const repo = createFakeRepository();
    for (const grant_types of [["implicit"], ["authorization_code", "client_credentials"], []]) {
      const { res, body } = await register(repo, { ...GOOD_REGISTRATION, grant_types });
      expect(res.status).toBe(400);
      expect(body["error"]).toBe("invalid_client_metadata");
    }
    const { res, body } = await register(repo, { ...GOOD_REGISTRATION, response_types: ["token"] });
    expect(res.status).toBe(400);
    expect(body["error"]).toBe("invalid_client_metadata");
  });

  it("rejects bad redirect_uris: missing, empty, http non-loopback, https loopback, custom scheme, fragment, >10", async () => {
    const repo = createFakeRepository();
    const cases: unknown[][] = [
      [],
      ["http://evil.example/cb"], // http must be loopback
      ["https://127.0.0.1/cb"], // https loopback is not a thing we accept
      ["cursor://callback"], // custom schemes are static-allow-list-only
      ["https://example.com/cb#frag"], // fragments forbidden (RFC 6749 §3.1.2)
      ["not a url"],
      [42],
      Array.from({ length: 11 }, (_, i) => `https://example.com/cb${i}`), // > 10
    ];
    for (const redirect_uris of cases) {
      const { res, body } = await register(repo, { ...GOOD_REGISTRATION, redirect_uris });
      expect(res.status).toBe(400);
      expect(body["error"]).toBe("invalid_redirect_uri");
    }
    const missing = await register(repo, { client_name: "X" });
    expect(missing.res.status).toBe(400);
    expect(missing.body["error"]).toBe("invalid_redirect_uri");
    expect(repo._dynamicClients.size).toBe(0);
  });

  it("rejects a non-object body with invalid_client_metadata", async () => {
    const repo = createFakeRepository();
    const raw = new Request("https://identity.internal/v1/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await handleOAuth2Register(raw, envWithKey(), "req_regbad", deps(repo));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client_metadata");
  });

  it("opportunistically GCs expired registrations on the register path (bounded)", async () => {
    const repo = createFakeRepository();
    const past = new Date(Date.now() - 1000);
    repo._dynamicClients.set("dcr_" + "0".repeat(32), {
      clientId: "dcr_" + "0".repeat(32),
      clientName: "Stale",
      redirectUris: ["https://stale.example/cb"],
      createdAt: new Date(past.getTime() - OAUTH_DYNAMIC_CLIENT_TTL_MS),
      lastUsedAt: null,
      expiresAt: past,
    });
    const { res } = await register(repo);
    expect(res.status).toBe(201);
    expect(repo._dynamicClients.has("dcr_" + "0".repeat(32))).toBe(false);
    expect(repo._dynamicClients.size).toBe(1); // just the fresh registration
  });
});

describe("client resolution (static-first, MCP11 leg B)", () => {
  it("a static clientId resolves from the allow-list even when a rogue dynamic row shares it", async () => {
    const repo = createFakeRepository();
    // Simulates a shadowing attempt: a dynamic row for a vetted id (the real
    // table's dcr_ CHECK forbids this; resolution order defends anyway).
    repo._dynamicClients.set("claude-web", {
      clientId: "claude-web",
      clientName: "Evil Claude",
      redirectUris: ["https://evil.example/cb"],
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: new Date(Date.now() + OAUTH_DYNAMIC_CLIENT_TTL_MS),
    });
    const resolved = await resolveOAuthClient(repo, "claude-web", new Date());
    expect(resolved).not.toBeNull();
    expect(resolved!.dynamic).toBe(false);
    expect(resolved!.name).toBe("Claude");
    expect(resolved!.redirectUris).not.toContain("https://evil.example/cb");

    // And the rogue redirect is rejected at authorize (static registration wins).
    const res = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId: "claude-web",
        redirectUri: "https://evil.example/cb",
        codeChallenge: await computeS256Challenge(VERIFIER),
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_shadow",
      deps(repo),
    );
    expect(res.status).toBe(422);
  });

  it("a non-dcr_ unknown id never consults the dynamic table", async () => {
    const repo = createFakeRepository();
    repo._dynamicClients.set("someday-client", {
      clientId: "someday-client",
      clientName: "Nope",
      redirectUris: ["https://x.example/cb"],
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: new Date(Date.now() + OAUTH_DYNAMIC_CLIENT_TTL_MS),
    });
    expect(await resolveOAuthClient(repo, "someday-client", new Date())).toBeNull();
  });

  it("an expired dynamic client resolves as unknown (authorize rejects with the standard error)", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const { body } = await register(repo);
    const clientId = body["client_id"] as string;
    repo._dynamicClients.get(clientId)!.expiresAt = new Date(Date.now() - 1000);

    expect(await resolveOAuthClient(repo, clientId, new Date())).toBeNull();

    const res = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId,
        redirectUri: GOOD_REGISTRATION.redirect_uris[0],
        codeChallenge: await computeS256Challenge(VERIFIER),
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_expired",
      deps(repo),
    );
    expect(res.status).toBe(422);
    const errBody = (await res.json()) as { error: { code: string; details: { fields: Record<string, string[]> } } };
    expect(errBody.error.code).toBe("validation_failed");
    expect(errBody.error.details.fields["clientId"]).toBeDefined();

    // And at the token endpoint: same unknown-client posture (invalid_client 401).
    const tok = await handleOAuth2Token(
      tokenRequest({
        grant_type: "authorization_code",
        code: "ocac_" + "0".repeat(64),
        client_id: clientId,
        redirect_uri: GOOD_REGISTRATION.redirect_uris[0]!,
        code_verifier: VERIFIER,
      }),
      envWithKey(),
      "req_expired_tok",
      deps(repo),
    );
    expect(tok.status).toBe(401);
    expect(((await tok.json()) as { error: string }).error).toBe("invalid_client");
  });
});

describe("full dynamic-client flow: register → authorize/complete → token (PKCE)", () => {
  it("mints an OP1 session labeled mcp:dcr_…, touches last_used_at, and extends the GC horizon", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const { body } = await register(repo);
    const clientId = body["client_id"] as string;
    const redirectUri = GOOD_REGISTRATION.redirect_uris[0]!;

    // Backdate the horizon so the redemption-driven extension is observable.
    const row = repo._dynamicClients.get(clientId)!;
    row.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const authz = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId,
        redirectUri,
        codeChallenge: await computeS256Challenge(VERIFIER),
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_dynauth",
      deps(repo),
    );
    expect(authz.status).toBe(201);
    const code = ((await authz.json()) as { data: { code: string } }).data.code;
    expect(code).toMatch(/^ocac_/);

    const tok = await handleOAuth2Token(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: VERIFIER,
      }),
      envWithKey(),
      "req_dyntok",
      deps(repo),
    );
    expect(tok.status).toBe(200);
    expect(tok.headers.get("cache-control")).toBe("no-store");
    const tokenBody = (await tok.json()) as Record<string, unknown>;
    expect(String(tokenBody["access_token"]).split(".")).toHaveLength(3);
    expect(tokenBody["refresh_token"]).toMatch(/^ocrt_/);

    // The minted session is an ordinary OP1 cli-kind session with the mcp label.
    const cliSessions = [...repo._sessions.values()].filter((s) => s.kind === "cli");
    expect(cliSessions).toHaveLength(1);
    expect(cliSessions[0]!.clientHost).toBe(`mcp:${clientId}`);

    // Redemption = use: last_used_at stamped, horizon pushed past the backdate.
    expect(row.lastUsedAt).not.toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });

  it("a dynamic client's redirect must match its OWN registration (exact for hosted URIs)", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const { body } = await register(repo);
    const clientId = body["client_id"] as string;

    const res = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId,
        redirectUri: "https://claude.ai/api/mcp/auth_callback", // claude-web's URI, not this registration's
        codeChallenge: await computeS256Challenge(VERIFIER),
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_dyncross",
      deps(repo),
    );
    expect(res.status).toBe(422);
  });

  it("a loopback-registered dynamic client gets the RFC 8252 any-port carve-out", async () => {
    const repo = createFakeRepository();
    seedUser(repo);
    const { body } = await register(repo, {
      client_name: "Local dev",
      redirect_uris: ["http://127.0.0.1/callback"],
    });
    const res = await handleOAuth2AuthorizeComplete(
      authorizeCompleteRequest({
        clientId: body["client_id"],
        redirectUri: "http://127.0.0.1:53123/callback",
        codeChallenge: await computeS256Challenge(VERIFIER),
        codeChallengeMethod: "S256",
      }),
      envWithKey(),
      "req_dynloop",
      deps(repo),
    );
    expect(res.status).toBe(201);
  });
});

describe("GET /v1/auth/oauth2/client/{clientId} (consent client info)", () => {
  it("resolves a static client (dynamic: false, envelope JSON)", async () => {
    const repo = createFakeRepository();
    const res = await handleOAuth2ClientInfo(clientInfoRequest("claude-web"), envWithKey(), "req_ci1", deps(repo));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { client: Record<string, unknown> } };
    expect(body.data.client).toEqual({
      clientId: "claude-web",
      name: "Claude",
      dynamic: false,
      redirectUris: [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
      ],
    });
  });

  it("resolves a dynamic client (dynamic: true) with its registered name + URIs", async () => {
    const repo = createFakeRepository();
    const { body } = await register(repo);
    const res = await handleOAuth2ClientInfo(
      clientInfoRequest(body["client_id"] as string),
      envWithKey(),
      "req_ci2",
      deps(repo),
    );
    expect(res.status).toBe(200);
    const info = (await res.json()) as { data: { client: Record<string, unknown> } };
    expect(info.data.client["dynamic"]).toBe(true);
    expect(info.data.client["name"]).toBe("Claude");
    expect(info.data.client["redirectUris"]).toEqual(GOOD_REGISTRATION.redirect_uris);
  });

  it("404s for unknown ids and expired registrations", async () => {
    const repo = createFakeRepository();
    const unknown = await handleOAuth2ClientInfo(
      clientInfoRequest("dcr_" + "f".repeat(32)),
      envWithKey(),
      "req_ci3",
      deps(repo),
    );
    expect(unknown.status).toBe(404);

    const { body } = await register(repo);
    const clientId = body["client_id"] as string;
    repo._dynamicClients.get(clientId)!.expiresAt = new Date(Date.now() - 1000);
    const expired = await handleOAuth2ClientInfo(clientInfoRequest(clientId), envWithKey(), "req_ci4", deps(repo));
    expect(expired.status).toBe(404);
  });
});
