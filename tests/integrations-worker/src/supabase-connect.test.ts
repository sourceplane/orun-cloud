// IH6: the Supabase adapter goes live — PKCE (S256) OAuth connect against the
// Management API (verifier in custody, never in the state), refresh-token
// custody with rotation-on-use re-enveloping, and live template-shaped access
// minting through the IH4 broker core.

import {
  handleConnectIntegration,
} from "@integrations-worker/handlers/connections";
import { handleSupabaseOauthCallback } from "@integrations-worker/handlers/supabase-oauth";
import { handleMintCredential } from "@integrations-worker/handlers/credential-broker";
import {
  buildSupabaseAuthorizeUrl,
  createSupabaseProvider,
  discoverSupabaseOrg,
  exchangeSupabaseOauthCode,
  listSupabaseProjects,
  refreshSupabaseAccess,
} from "@integrations-worker/providers/supabase";
import { computeCodeChallenge, generateCodeVerifier } from "@integrations-worker/pkce";
import { createEncryptionAdapter, type CiphertextEnvelope } from "@integrations-worker/encryption";
import { signConnectState, CONNECT_STATE_TTL_MS } from "@integrations-worker/state";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_UUID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = asUuid(ORG_UUID);
const STATE_SECRET = "state-secret";
const KEY = "ef".repeat(32); // 64 hex chars = 256-bit key
const REDIRECT_BASE = "https://api-edge.test";
const SUPABASE_ORG_ID = "sb-org-1";
const NOW = new Date("2026-07-12T15:00:00Z");

const CREDS = { clientId: "sb-cid", clientSecret: "sb-cs" };

type QueryRecord = { text: string; params: unknown[] };
type SqlResponder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: SqlResponder): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      let rows = respond(text, params ?? []);
      if ((rows === null || rows.length === 0) && text.includes("WITH inserted_event")) {
        rows = [{ _event: { id: "evt", payload: {} }, _audit: { id: "aud", payload: {} } }];
      }
      return { rows: (rows ?? []) as unknown as T[], rowCount: (rows ?? []).length };
    },
  };
  return { executor, queries };
}

function jsonFetcher(body: unknown): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json(body)),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function billingFetcher(allowed: boolean, reason?: string): Fetcher {
  return {
    fetch: async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { entitlementKey: string; orgId: string };
      return Response.json({
        data: {
          allowed,
          orgId: body.orgId,
          entitlementKey: body.entitlementKey,
          valueType: "boolean",
          limitValue: null,
          source: "plan",
          subscriptionId: "s",
          ...(reason ? { reason } : {}),
        },
      });
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [
          { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } },
        ],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
    BILLING_WORKER: billingFetcher(true),
    INTEGRATIONS_STATE_SECRET: STATE_SECRET,
    SECRET_ENCRYPTION_KEY: KEY,
    OAUTH_REDIRECT_BASE_URL: REDIRECT_BASE,
    SUPABASE_OAUTH_CLIENT_ID: CREDS.clientId,
    SUPABASE_OAUTH_CLIENT_SECRET: CREDS.clientSecret,
    ...overrides,
  } as unknown as Env;
}

const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

/** Fake Supabase Management API: token exchange/refresh, org + project
 *  discovery. Records every call. */
function supabaseApi(overrides?: {
  exchangeFails?: boolean;
  refreshFails?: boolean;
  rotatedRefreshToken?: string | null;
  orgs?: Array<Record<string, unknown>> | null;
  projectsFail?: boolean;
  expiresIn?: number;
}): {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; method: string; body: string | null; auth: string | null }>;
} {
  const calls: Array<{ url: string; method: string; body: string | null; auth: string | null }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (input.includes("/v1/oauth/token")) {
      const params = new URLSearchParams(String(init?.body));
      if (params.get("grant_type") === "authorization_code") {
        if (overrides?.exchangeFails) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({
          access_token: "sb-access-SECRET",
          refresh_token: "sb-refresh-OLD",
          expires_in: overrides?.expiresIn ?? 3600,
          token_type: "Bearer",
        });
      }
      // grant_type=refresh_token — rotation on use.
      if (overrides?.refreshFails) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const rotated =
        overrides?.rotatedRefreshToken === undefined
          ? "sb-refresh-NEW"
          : overrides.rotatedRefreshToken;
      return Response.json({
        access_token: "sb-access-SECRET",
        ...(rotated === null ? {} : { refresh_token: rotated }),
        expires_in: overrides?.expiresIn ?? 3600,
        token_type: "Bearer",
      });
    }
    if (input.includes("/v1/organizations")) {
      return Response.json(
        overrides?.orgs === undefined
          ? [{ id: SUPABASE_ORG_ID, name: "Acme Data" }]
          : overrides.orgs ?? [],
      );
    }
    if (input.includes("/v1/projects")) {
      if (overrides?.projectsFail) return new Response("nope", { status: 500 });
      return Response.json([
        { id: "proj-ref-1", name: "app-db" },
        { ref: "proj-ref-2", name: "analytics" },
      ]);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

function pendingRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "supabase",
    status: "pending",
    scope: "account",
    share_mode: "auto",
    display_name: null,
    external_account_login: null,
    external_account_id: null,
    external_account_type: null,
    created_by: "usr_abc",
    state_expires_at: new Date(NOW.getTime() + CONNECT_STATE_TTL_MS).toISOString(),
    connected_at: null,
    suspended_at: null,
    revoked_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function supabaseOrgRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "sb-facts-row",
    connection_id: CONNECTION_UUID,
    supabase_org_id: SUPABASE_ORG_ID,
    org_name: "Acme Data",
    granted_scopes: null,
    projects: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

async function verifierCustodyRow(verifier: string): Promise<Record<string, unknown>> {
  const adapter = (await createEncryptionAdapter(KEY))!;
  const envelope = await adapter.encrypt(verifier);
  return {
    id: "pkce-row",
    connection_id: CONNECTION_UUID,
    kind: "supabase_pkce_verifier",
    ciphertext: JSON.stringify(envelope),
    scopes: null,
    external_ref: null,
    expires_at: null,
    rotated_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

// ── PKCE helpers ────────────────────────────────────────────

describe("pkce helpers (IH6)", () => {
  it("generates a 43-char base64url verifier, fresh every call", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("computes the S256 challenge (RFC 7636 appendix B vector)", async () => {
    await expect(
      computeCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

// ── Adapter units ───────────────────────────────────────────

describe("supabase adapter (IH6)", () => {
  it("builds the PKCE authorize URL with challenge + signed state", () => {
    const url = new URL(
      buildSupabaseAuthorizeUrl({
        clientId: "sb-cid",
        state: "signed-state",
        redirectUri: `${REDIRECT_BASE}/ingress/supabase/oauth`,
        codeChallenge: "the-challenge",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://api.supabase.com/v1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("sb-cid");
    expect(url.searchParams.get("redirect_uri")).toBe(`${REDIRECT_BASE}/ingress/supabase/oauth`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges the code form-encoded with the verifier; validates the pair", async () => {
    const api = supabaseApi();
    const grant = await exchangeSupabaseOauthCode(
      CREDS,
      { code: "c0de", redirectUri: `${REDIRECT_BASE}/ingress/supabase/oauth`, codeVerifier: "v3rifier" },
      api.fetchImpl,
    );
    expect(grant).toEqual({
      accessToken: "sb-access-SECRET",
      refreshToken: "sb-refresh-OLD",
      expiresIn: 3600,
    });
    const call = api.calls[0]!;
    const params = new URLSearchParams(call.body!);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("client_id")).toBe("sb-cid");
    expect(params.get("client_secret")).toBe("sb-cs");
    expect(params.get("code")).toBe("c0de");
    expect(params.get("redirect_uri")).toBe(`${REDIRECT_BASE}/ingress/supabase/oauth`);
    expect(params.get("code_verifier")).toBe("v3rifier");
  });

  it("returns null on a refused exchange, malformed payloads, or transport failure", async () => {
    const refused = supabaseApi({ exchangeFails: true });
    await expect(
      exchangeSupabaseOauthCode(CREDS, { code: "c", redirectUri: "https://e/x", codeVerifier: "v" }, refused.fetchImpl),
    ).resolves.toBeNull();
    await expect(
      exchangeSupabaseOauthCode(CREDS, { code: "c", redirectUri: "https://e/x", codeVerifier: "v" }, () =>
        Promise.resolve(Response.json({ access_token: "a" })), // no refresh token
      ),
    ).resolves.toBeNull();
    await expect(
      exchangeSupabaseOauthCode(CREDS, { code: "c", redirectUri: "https://e/x", codeVerifier: "v" }, () =>
        Promise.reject(new Error("boom")),
      ),
    ).resolves.toBeNull();
  });

  it("surfaces the ROTATED refresh token on refresh, falling back to the input", async () => {
    const rotated = await refreshSupabaseAccess(CREDS, "sb-refresh-OLD", supabaseApi().fetchImpl);
    expect(rotated).toEqual({
      accessToken: "sb-access-SECRET",
      refreshToken: "sb-refresh-NEW",
      expiresIn: 3600,
    });
    // A response without a refresh_token keeps the input parent alive.
    const kept = await refreshSupabaseAccess(
      CREDS,
      "sb-refresh-OLD",
      supabaseApi({ rotatedRefreshToken: null }).fetchImpl,
    );
    expect(kept!.refreshToken).toBe("sb-refresh-OLD");
    // A refused refresh is null — the grant was revoked provider-side.
    await expect(
      refreshSupabaseAccess(CREDS, "sb-refresh-OLD", supabaseApi({ refreshFails: true }).fetchImpl),
    ).resolves.toBeNull();
  });

  it("discovers the org behind the grant and lists project projections", async () => {
    const api = supabaseApi();
    await expect(discoverSupabaseOrg("sb-access-SECRET", api.fetchImpl)).resolves.toEqual({
      supabaseOrgId: SUPABASE_ORG_ID,
      orgName: "Acme Data",
    });
    expect(api.calls[0]!.auth).toBe("Bearer sb-access-SECRET");
    await expect(listSupabaseProjects("sb-access-SECRET", api.fetchImpl)).resolves.toEqual([
      { ref: "proj-ref-1", name: "app-db" },
      { ref: "proj-ref-2", name: "analytics" },
    ]);
    // No org visible / projects unavailable → null, never a throw.
    await expect(
      discoverSupabaseOrg("sb-access-SECRET", supabaseApi({ orgs: [] }).fetchImpl),
    ).resolves.toBeNull();
    await expect(
      listSupabaseProjects("sb-access-SECRET", supabaseApi({ projectsFail: true }).fetchImpl),
    ).resolves.toBeNull();
  });

  it("db-migrate / functions-deploy refuse without a projectRef BEFORE spending the parent", async () => {
    const api = supabaseApi();
    const provider = createSupabaseProvider(CREDS, api.fetchImpl);
    for (const template of ["db-migrate", "functions-deploy"]) {
      const outcome = await provider.broker!.mintCredential({
        template,
        params: {},
        ttlSeconds: 900,
        nowMs: NOW.getTime(),
        parent: { credential: "sb-refresh-OLD", externalRef: SUPABASE_ORG_ID },
      });
      expect(outcome).toMatchObject({ ok: false, reason: "provider_error" });
    }
    // The doomed mints never consumed (rotated) the refresh token.
    expect(api.calls).toHaveLength(0);
  });

  it("maps a refused refresh to parent_grant_insufficient", async () => {
    const provider = createSupabaseProvider(CREDS, supabaseApi({ refreshFails: true }).fetchImpl);
    const outcome = await provider.broker!.mintCredential({
      template: "management-access",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: "sb-refresh-OLD", externalRef: SUPABASE_ORG_ID },
    });
    expect(outcome).toMatchObject({ ok: false, reason: "parent_grant_insufficient" });
  });

  it("mints management-access: honest expiry, no providerRef, rotation surfaced", async () => {
    const provider = createSupabaseProvider(CREDS, supabaseApi({ expiresIn: 3600 }).fetchImpl);
    const outcome = await provider.broker!.mintCredential({
      template: "management-access",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: "sb-refresh-OLD", externalRef: SUPABASE_ORG_ID },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.credential).toEqual({ accessToken: "sb-access-SECRET" });
      expect(outcome.value.providerRef).toBeNull();
      // min(clamped ttl 900, provider expiry 3600) — the SHORTER, honestly.
      expect(outcome.value.expiresAt).toEqual(new Date(NOW.getTime() + 900_000));
      expect(outcome.value.rotatedParentCredential).toBe("sb-refresh-NEW");
    }
  });

  it("reports the provider-fixed expiry when it is shorter than the request", async () => {
    const provider = createSupabaseProvider(CREDS, supabaseApi({ expiresIn: 600 }).fetchImpl);
    const outcome = await provider.broker!.mintCredential({
      template: "db-migrate",
      params: { projectRef: "proj-ref-1" },
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: "sb-refresh-OLD", externalRef: SUPABASE_ORG_ID },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.credential).toEqual({
        accessToken: "sb-access-SECRET",
        projectRef: "proj-ref-1",
      });
      expect(outcome.value.expiresAt).toEqual(new Date(NOW.getTime() + 600_000));
    }
  });

  it("omits rotatedParentCredential when the provider kept the parent", async () => {
    const provider = createSupabaseProvider(
      CREDS,
      supabaseApi({ rotatedRefreshToken: "sb-refresh-OLD" }).fetchImpl,
    );
    const outcome = await provider.broker!.mintCredential({
      template: "management-access",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: "sb-refresh-OLD", externalRef: SUPABASE_ORG_ID },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.rotatedParentCredential).toBeUndefined();
  });

  it("has no provider-side revoke — TTL is the backstop", async () => {
    const provider = createSupabaseProvider(CREDS, supabaseApi().fetchImpl);
    await expect(provider.broker!.revokeCredential("anything", NOW.getTime())).resolves.toBe(false);
  });
});

// ── Connect (PKCE start) ────────────────────────────────────

describe("POST …/integrations/supabase/connect", () => {
  function connectRequest(): Request {
    return new Request("https://worker.test/v1/organizations/x/integrations/supabase/connect", {
      method: "POST",
      headers: { "content-length": "0" },
    });
  }

  it("gates on the SUPABASE entitlement key", async () => {
    const env = createEnv({ BILLING_WORKER: billingFetcher(false, "disabled") });
    const { executor } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "supabase", { executor });
    expect(res.status).toBe(412);
    const error = (await json(res)).error as Record<string, unknown>;
    const details = error.details as Record<string, unknown>;
    expect(details.entitlementKey).toBe("feature.integrations.supabase");
    expect(details.reason).toBe("disabled");
  });

  it("parks on D4 with 412/not_configured while the OAuth app secrets are unset", async () => {
    const env = createEnv({ SUPABASE_OAUTH_CLIENT_ID: undefined });
    const { executor } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "supabase", { executor });
    expect(res.status).toBe(412);
    const error = (await json(res)).error as Record<string, unknown>;
    expect((error.details as Record<string, unknown>).gate).toBe("supabase_oauth_registration");
  });

  it("parks with 412 BEFORE creating the connection when custody (the key) is unset", async () => {
    const env = createEnv({ SECRET_ENCRYPTION_KEY: undefined });
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "supabase", { executor });
    expect(res.status).toBe(412);
    const error = (await json(res)).error as Record<string, unknown>;
    expect((error.details as Record<string, unknown>).gate).toBe("supabase_oauth_registration");
    expect(queries).toHaveLength(0);
  });

  it("creates a pending connection, envelopes the PKCE verifier, returns the authorize URL", async () => {
    const env = createEnv();
    let custodyInsert: unknown[] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("INSERT INTO integrations.connections")) {
        return [pendingRow({ id: params[0] as string })];
      }
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        custodyInsert = params;
        return [{
          id: "pkce-row", connection_id: params[1], kind: params[2], ciphertext: params[3],
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      return [];
    });

    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "supabase", { executor });
    expect(res.status).toBe(201);
    const data = (await json(res)).data as Record<string, unknown>;
    expect((data.connection as Record<string, unknown>).provider).toBe("supabase");

    const authorizeUrl = new URL(data.installUrl as string);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://api.supabase.com/v1/oauth/authorize",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("sb-cid");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${REDIRECT_BASE}/ingress/supabase/oauth`);
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = authorizeUrl.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // PKCE custody: the enveloped verifier decrypts back AND matches the
    // challenge the authorize URL carries.
    expect(custodyInsert[2]).toBe("supabase_pkce_verifier");
    const adapter = (await createEncryptionAdapter(KEY))!;
    const verifier = await adapter.decrypt(JSON.parse(custodyInsert[3] as string) as CiphertextEnvelope);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    await expect(computeCodeChallenge(verifier)).resolves.toBe(challenge);
  });
});

// ── OAuth callback (tenancy keystone + PKCE consume) ────────

describe("GET /ingress/supabase/oauth", () => {
  function callbackRequest(params: Record<string, string>): Request {
    const url = new URL("https://worker.test/ingress/supabase/oauth");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new Request(url.toString(), { method: "GET" });
  }

  async function mintState(
    overrides?: Partial<{ n: string; p: string; c: string; o: string; exp: number }>,
  ): Promise<{ state: string; nonce: string }> {
    const nonce = overrides?.n ?? "e".repeat(32);
    const state = await signConnectState(
      {
        n: nonce,
        p: overrides?.p ?? "supabase",
        c: overrides?.c ?? CONNECTION_UUID,
        o: overrides?.o ?? ORG_UUID,
        exp: overrides?.exp ?? Date.now() + CONNECT_STATE_TTL_MS,
      },
      STATE_SECRET,
    );
    return { state, nonce };
  }

  it("reports a user-cancelled authorization without touching the DB", async () => {
    const { fetchImpl } = supabaseApi();
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleSupabaseOauthCallback(
      callbackRequest({ error: "access_denied" }),
      createEnv(), "req_1", { executor, fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it("fails a state-less callback closed with NO writes (no orphan path exists)", async () => {
    const api = supabaseApi();
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleSupabaseOauthCallback(
      callbackRequest({ code: "c0de" }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Connection not completed");
    // Without the state there is no verifier, hence no exchange to run —
    // nothing was written, nothing was called.
    expect(queries).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it("fails replayed/expired state (nonce no longer consumable) closed", async () => {
    const api = supabaseApi();
    const { state } = await mintState();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return []; // already consumed
      return [];
    });
    const res = await handleSupabaseOauthCallback(
      callbackRequest({ code: "c0de", state }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(api.calls).toHaveLength(0);
    expect(queries.some((q) => q.text.includes("INSERT INTO"))).toBe(false);
  });

  it("rejects state whose payload disagrees with the consumed row (cross-org redemption)", async () => {
    const api = supabaseApi();
    const { state } = await mintState({ o: OTHER_ORG_UUID });
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      return [];
    });
    const res = await handleSupabaseOauthCallback(
      callbackRequest({ code: "c0de", state }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(api.calls).toHaveLength(0);
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });

  it("fails closed when the PKCE verifier custody row is missing", async () => {
    const api = supabaseApi();
    const { state } = await mintState();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      // getProviderCredential(supabase_pkce_verifier) → no row.
      return [];
    });
    const res = await handleSupabaseOauthCallback(
      callbackRequest({ code: "c0de", state }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Connection not completed");
    // The exchange never ran without the verifier.
    expect(api.calls).toHaveLength(0);
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });

  it("fails closed when Supabase refuses the code exchange — verifier still consumed", async () => {
    const api = supabaseApi({ exchangeFails: true });
    const { state } = await mintState();
    const custody = await verifierCustodyRow("pkce-verifier-under-test-aaaaaaaaaaaaaaaaaaa");
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) return [custody];
      return [];
    });
    const res = await handleSupabaseOauthCallback(
      callbackRequest({ code: "bad-c0de", state }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Verification failed");
    // The verifier was deleted BEFORE the exchange — consumed either way.
    expect(queries.some((q) => q.text.includes("DELETE FROM integrations.provider_credentials"))).toBe(true);
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });

  it("activates: verifier consumed, refresh-token custody, org facts, event", async () => {
    const verifier = "pkce-verifier-under-test-aaaaaaaaaaaaaaaaaaa";
    const api = supabaseApi();
    const { state } = await mintState();
    const custody = await verifierCustodyRow(verifier);
    let credentialInsert: unknown[] = [];
    let factsInsert: unknown[] = [];
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) return [custody];
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        credentialInsert = params;
        return [{
          id: "cred-row", connection_id: CONNECTION_UUID, kind: params[2], ciphertext: params[3],
          external_ref: params[5], created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("INSERT INTO integrations.supabase_orgs")) {
        factsInsert = params;
        return [supabaseOrgRow()];
      }
      if (text.includes("SET status = 'active'")) {
        return [pendingRow({
          status: "active",
          external_account_login: "Acme Data",
          external_account_id: SUPABASE_ORG_ID,
          external_account_type: "organization",
          connected_at: NOW.toISOString(),
        })];
      }
      return [];
    });

    const res = await handleSupabaseOauthCallback(
      callbackRequest({ code: "c0de", state }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Supabase connected");

    // The verifier custody row was read once and DELETED (consumed).
    const deleteIdx = queries.findIndex((q) =>
      q.text.includes("DELETE FROM integrations.provider_credentials"),
    );
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(queries[deleteIdx]!.params).toEqual([CONNECTION_UUID, "supabase_pkce_verifier"]);

    // The exchange carried the DECRYPTED verifier and our exact redirect_uri.
    const exchange = api.calls.find((c) => c.body?.includes("grant_type=authorization_code"));
    expect(exchange).toBeDefined();
    const exchangeParams = new URLSearchParams(exchange!.body!);
    expect(exchangeParams.get("code_verifier")).toBe(verifier);
    expect(exchangeParams.get("redirect_uri")).toBe(`${REDIRECT_BASE}/ingress/supabase/oauth`);

    // Custody: the REFRESH token (never the access token) as a real envelope,
    // anchored to the Supabase org id.
    expect(credentialInsert[2]).toBe("supabase_refresh_token");
    expect(credentialInsert[5]).toBe(SUPABASE_ORG_ID);
    const ciphertext = credentialInsert[3] as string;
    expect(ciphertext).not.toContain("sb-refresh-OLD");
    const adapter = (await createEncryptionAdapter(KEY))!;
    expect(await adapter.decrypt(JSON.parse(ciphertext) as CiphertextEnvelope)).toBe("sb-refresh-OLD");

    // Org facts bound to the connection from OUR state, projects best-effort.
    expect(factsInsert[1]).toBe(CONNECTION_UUID);
    expect(factsInsert[2]).toBe(SUPABASE_ORG_ID);
    expect(String(factsInsert[5])).toContain("proj-ref-1");

    // Activation used the org + connection from the state, org facts from Supabase.
    const activate = queries.find((q) => q.text.includes("SET status = 'active'"));
    expect(activate).toBeDefined();
    expect(activate!.params[0]).toBe(ORG_UUID);
    expect(activate!.params[1]).toBe(CONNECTION_UUID);
    expect(activate!.params[3]).toBe("Acme Data"); // external_account_login
    expect(activate!.params[4]).toBe(SUPABASE_ORG_ID); // external_account_id
    expect(activate!.params[5]).toBe("organization"); // external_account_type

    // Connected event emitted with safe facts only.
    const events = queries.filter((q) => q.text.includes("WITH inserted_event"));
    expect(events.length).toBeGreaterThan(0);
    const eventJson = JSON.stringify(events.map((q) => q.params));
    expect(eventJson).toContain("supabase");
    expect(eventJson).not.toContain("sb-refresh-OLD");
    expect(eventJson).not.toContain("sb-access-SECRET");
  });

  it("refuses to flip an org already bound to another connection", async () => {
    const api = supabaseApi();
    const { state } = await mintState();
    const custody = await verifierCustodyRow("pkce-verifier-under-test-aaaaaaaaaaaaaaaaaaa");
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) return [custody];
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        return [{
          id: "cred-row", connection_id: CONNECTION_UUID, kind: params[2], ciphertext: params[3],
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("INSERT INTO integrations.supabase_orgs")) {
        return [supabaseOrgRow({ connection_id: "44444444-4444-4444-8444-444444444444" })];
      }
      return [];
    });
    const res = await handleSupabaseOauthCallback(
      callbackRequest({ code: "c0de", state }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Already connected");
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });

  it("parks with a not-configured popup when the encryption key is unset", async () => {
    const { fetchImpl } = supabaseApi();
    const { state } = await mintState();
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleSupabaseOauthCallback(
      callbackRequest({ code: "c0de", state }),
      createEnv({ SECRET_ENCRYPTION_KEY: undefined }), "req_1", { executor, fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Not configured");
    expect(queries).toHaveLength(0);
  });
});

// ── Mint through the IH4 core with real custody ─────────────

describe("mint via broker core (supabase)", () => {
  function mintRequest(body: Record<string, unknown>): Request {
    return new Request("https://worker.test/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function connectionRow(): Record<string, unknown> {
    return {
      id: CONNECTION_UUID, org_id: ORG_UUID, provider: "supabase", status: "active",
      scope: "account", share_mode: "auto", created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    };
  }

  async function refreshCustodyRow(): Promise<Record<string, unknown>> {
    const adapter = (await createEncryptionAdapter(KEY))!;
    const envelope = await adapter.encrypt("sb-refresh-OLD");
    return {
      id: "cred", connection_id: CONNECTION_UUID, kind: "supabase_refresh_token",
      ciphertext: JSON.stringify(envelope), external_ref: SUPABASE_ORG_ID,
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    };
  }

  it("decrypts custody, mints, and re-envelopes the ROTATED refresh token", async () => {
    const api = supabaseApi();
    const custody = await refreshCustodyRow();
    let ledgerInsert: unknown[] = [];
    const custodyUpserts: unknown[][] = [];
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) return [custody];
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        custodyUpserts.push(params);
        return [{
          id: params[0], connection_id: params[1], kind: params[2], ciphertext: params[3],
          external_ref: params[5], created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("INSERT INTO integrations.minted_credentials")) {
        ledgerInsert = params;
        return [{
          id: params[0], org_id: ORG_UUID, connection_id: CONNECTION_UUID, provider: "supabase",
          template: "management-access", purpose: "api", ttl_seconds: params[10],
          provider_ref: params[11], minted_at: NOW.toISOString(),
          expires_at: new Date(NOW.getTime() + 900_000).toISOString(), revoke_status: "pending",
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      return [];
    });

    const res = await handleMintCredential(
      mintRequest({ template: "management-access" }),
      createEnv(), "req_1", ACTOR, ORG_ID, asUuid(CONNECTION_UUID),
      { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(201);
    const data = ((await res.json()) as { data: { credential: Record<string, string> } }).data;
    expect(data.credential.accessToken).toBe("sb-access-SECRET");

    // The rotation was re-enveloped: a provider_credentials upsert with the
    // SAME kind + externalRef whose ciphertext decrypts to the NEW token.
    expect(custodyUpserts).toHaveLength(1);
    const upsert = custodyUpserts[0]!;
    expect(upsert[2]).toBe("supabase_refresh_token");
    expect(upsert[5]).toBe(SUPABASE_ORG_ID);
    const adapter = (await createEncryptionAdapter(KEY))!;
    expect(await adapter.decrypt(JSON.parse(upsert[3] as string) as CiphertextEnvelope)).toBe("sb-refresh-NEW");

    // Re-envelope happened BEFORE the ledger insert.
    const upsertIdx = queries.findIndex((q) => q.text.includes("INSERT INTO integrations.provider_credentials"));
    const ledgerIdx = queries.findIndex((q) => q.text.includes("INSERT INTO integrations.minted_credentials"));
    expect(upsertIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeLessThan(ledgerIdx);

    // No provider-side ref exists; TTL is the backstop.
    expect(ledgerInsert[11]).toBeNull();
    // The ledger + events never carry the credential or the refresh tokens.
    const allParams = JSON.stringify(queries.map((q) => q.params));
    expect(JSON.stringify(ledgerInsert)).not.toContain("sb-access-SECRET");
    expect(allParams).not.toContain("sb-refresh-OLD");
  });

  it("502s a db-migrate mint missing projectRef (typed provider_error, parent unspent)", async () => {
    const api = supabaseApi();
    const custody = await refreshCustodyRow();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) return [custody];
      return [];
    });
    const res = await handleMintCredential(
      mintRequest({ template: "db-migrate" }),
      createEnv(), "req_1", ACTOR, ORG_ID, asUuid(CONNECTION_UUID),
      { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(502);
    expect(api.calls).toHaveLength(0); // the refresh token was not consumed
    expect(queries.some((q) => q.text.includes("INSERT INTO integrations.minted_credentials"))).toBe(false);
  });

  it("412s when the parent refresh-token custody row is missing", async () => {
    const api = supabaseApi();
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      return []; // no custody row
    });
    const res = await handleMintCredential(
      mintRequest({ template: "management-access" }),
      createEnv(), "req_1", ACTOR, ORG_ID, asUuid(CONNECTION_UUID),
      { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(412);
    const error = ((await res.json()) as { error: { details: Record<string, unknown> } }).error;
    expect(error.details.reason).toBe("parent_credential_missing");
    expect(api.calls).toHaveLength(0);
  });
});
