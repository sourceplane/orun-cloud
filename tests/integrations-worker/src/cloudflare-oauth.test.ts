// IH5 (risks D3 resolved): the Cloudflare adapter gains an OAuth connect
// posture — PKCE (S256) against Cloudflare's OAuth-client authorization server
// (verifier in custody, never in the state), refresh-token custody with
// rotation-on-use re-enveloping, and the SAME scoped child-token minting as
// token-paste — only the API bearer's source differs (a refreshed access
// token instead of the pasted parent). Structurally the Supabase (IH6) twin.

import { handleConnectIntegration } from "@integrations-worker/handlers/connections";
import { handleCloudflareOauthCallback } from "@integrations-worker/handlers/cloudflare-oauth";
import {
  buildCloudflareAuthorizeUrl,
  CLOUDFLARE_DEFAULT_OAUTH_SCOPE,
  createCloudflareProvider,
  exchangeCloudflareOauthCode,
  OAUTH_SCOPE_BY_PERMISSION_GROUP,
  refreshCloudflareAccess,
  resolveCloudflareOauthScope,
  serviceIdentityPermissionGroups,
} from "@integrations-worker/providers/cloudflare";
import { getConfiguredProvider } from "@integrations-worker/providers/registry";
import { computeCodeChallenge } from "@integrations-worker/pkce";
import { createEncryptionAdapter, type CiphertextEnvelope } from "@integrations-worker/encryption";
import { signConnectState, CONNECT_STATE_TTL_MS } from "@integrations-worker/state";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = asUuid(ORG_UUID);
const STATE_SECRET = "state-secret";
const KEY = "cd".repeat(32);
const REDIRECT_BASE = "https://api-edge.test";
const ACCOUNT_ID = "9a7806061c88ada191ed06f989cc3dac";
const NOW = new Date("2026-07-12T14:00:00Z");
const CREDS = { clientId: "cf-cid", clientSecret: "cf-cs" };

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
          valueType: "quantity",
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
    CLOUDFLARE_OAUTH_CLIENT_ID: CREDS.clientId,
    CLOUDFLARE_OAUTH_CLIENT_SECRET: CREDS.clientSecret,
    ...overrides,
  } as unknown as Env;
}

const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

/** Fake Cloudflare API: OAuth token endpoint (exchange + refresh, rotation on
 *  use), account discovery, permission groups, child-token create. Records
 *  every call. */
function cloudflareApi(overrides?: {
  exchangeFails?: boolean;
  refreshFails?: boolean;
  rotatedRefreshToken?: string | null;
  accounts?: Array<Record<string, unknown>>;
  createStatus?: number;
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
    if (input.includes("/oauth2/token")) {
      const params = new URLSearchParams(String(init?.body));
      if (params.get("grant_type") === "authorization_code") {
        if (overrides?.exchangeFails) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          access_token: "cf-access-SECRET",
          refresh_token: "cf-refresh-OLD",
          expires_in: overrides?.expiresIn ?? 3600,
          token_type: "Bearer",
        });
      }
      // grant_type=refresh_token — may rotate the refresh token on use.
      if (overrides?.refreshFails) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const rotated =
        overrides?.rotatedRefreshToken === undefined ? "cf-refresh-NEW" : overrides.rotatedRefreshToken;
      return Response.json({
        access_token: "cf-access-SECRET",
        ...(rotated === null ? {} : { refresh_token: rotated }),
        expires_in: overrides?.expiresIn ?? 3600,
        token_type: "Bearer",
      });
    }
    if (input.includes("/accounts?")) {
      return Response.json({
        success: true,
        result: overrides?.accounts ?? [{ id: ACCOUNT_ID, name: "Acme Infra" }],
      });
    }
    if (input.includes("/user/tokens/permission_groups")) {
      // The FULL union the SI2 service identity needs, so the OAuth connect
      // provisions successfully in these tests.
      return Response.json({
        success: true,
        result: serviceIdentityPermissionGroups().map((name, i) => ({ id: `pg-${i}`, name })),
      });
    }
    if (input.includes("/user/tokens/verify")) {
      return Response.json({
        success: true,
        result: { id: "svc-token-id", status: "active", expires_on: null },
      });
    }
    if (input.includes(`/accounts/${ACCOUNT_ID}/tokens`) && (init?.method ?? "GET") === "POST") {
      if (overrides?.createStatus) {
        return Response.json({ success: false, errors: [{ message: "denied" }] }, { status: overrides.createStatus });
      }
      const name = String((JSON.parse(String(init?.body)) as { name?: string }).name ?? "");
      return name.endsWith("/service")
        ? Response.json({ success: true, result: { id: "svc-token-id", value: "cf-service-SECRET" } })
        : Response.json({ success: true, result: { id: "child-token-id", value: "cf-child-SECRET" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

function pendingRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "cloudflare",
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

async function verifierCustodyRow(verifier: string): Promise<Record<string, unknown>> {
  const adapter = (await createEncryptionAdapter(KEY))!;
  const envelope = await adapter.encrypt(verifier);
  return {
    id: "pkce-row",
    connection_id: CONNECTION_UUID,
    kind: "cloudflare_pkce_verifier",
    ciphertext: JSON.stringify(envelope),
    scopes: null,
    external_ref: null,
    expires_at: null,
    rotated_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ── Adapter units ───────────────────────────────────────────

describe("cloudflare OAuth adapter (IH5 / D3)", () => {
  it("builds the PKCE authorize URL with challenge + signed state", () => {
    const url = new URL(
      buildCloudflareAuthorizeUrl({
        clientId: "cf-cid",
        state: "signed-state",
        redirectUri: `${REDIRECT_BASE}/ingress/cloudflare/oauth`,
        codeChallenge: "the-challenge",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(url.searchParams.get("client_id")).toBe("cf-cid");
    expect(url.searchParams.get("redirect_uri")).toBe(`${REDIRECT_BASE}/ingress/cloudflare/oauth`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // A scope-less authorize request is what made Cloudflare's consent page die
    // with "unexpected error during authorization" — the URL MUST carry a scope,
    // and it MUST include offline_access (else no refresh token comes back).
    const scope = url.searchParams.get("scope");
    expect(scope).toBeTruthy();
    expect(scope!.split(" ")).toContain("offline_access");
  });

  it("sends operator-supplied resource scopes verbatim, always ensuring offline_access", () => {
    const url = new URL(
      buildCloudflareAuthorizeUrl({
        clientId: "cf-cid",
        state: "s",
        redirectUri: `${REDIRECT_BASE}/ingress/cloudflare/oauth`,
        scope: "workers-platform.read account.read",
      }),
    );
    expect(url.searchParams.get("scope")).toBe(
      "workers-platform.read account.read offline_access",
    );
  });

  it("defaults to the FULL provisioning scope set when none is requested", () => {
    // A self-managed client grants the token ONLY the requested scopes — the
    // live SI-D1 incident: a 2-permission consent made an account OWNER's
    // grant unable to create tokens. So the default requests account
    // discovery PLUS the dot-form twin of every service-identity permission
    // group, so an unset CLOUDFLARE_OAUTH_SCOPE yields a consent whose grant
    // can actually provision.
    const url = new URL(
      buildCloudflareAuthorizeUrl({
        clientId: "cf-cid",
        state: "s",
        redirectUri: `${REDIRECT_BASE}/ingress/cloudflare/oauth`,
      }),
    );
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("account-settings.read");
    expect(scopes).toContain("memberships.read");
    expect(scopes).toContain("account-api-tokens.write");
    expect(scopes[scopes.length - 1]).toBe("offline_access");

    // Every permission group the provisioner requires has its scope twin in
    // the default — the map and the group union can never drift apart.
    for (const group of serviceIdentityPermissionGroups()) {
      const scope = OAUTH_SCOPE_BY_PERMISSION_GROUP[group];
      expect(scope).toBeTruthy();
      expect(CLOUDFLARE_DEFAULT_OAUTH_SCOPE.split(" ")).toContain(scope!);
    }
  });

  describe("resolveCloudflareOauthScope", () => {
    it("appends offline_access exactly once, even if already requested", () => {
      expect(resolveCloudflareOauthScope("workers-platform.read offline_access")).toBe(
        "workers-platform.read offline_access",
      );
      expect(resolveCloudflareOauthScope("offline_access workers-platform.read")).toBe(
        "workers-platform.read offline_access",
      );
    });

    it("collapses whitespace and de-duplicates scopes deterministically", () => {
      expect(resolveCloudflareOauthScope("  account.read   user.read  account.read ")).toBe(
        "account.read user.read offline_access",
      );
    });

    it("uses the provisioning default (+offline_access) for blank/undefined input", () => {
      expect(resolveCloudflareOauthScope()).toBe(
        `${CLOUDFLARE_DEFAULT_OAUTH_SCOPE} offline_access`,
      );
      expect(resolveCloudflareOauthScope("   ")).toBe(
        `${CLOUDFLARE_DEFAULT_OAUTH_SCOPE} offline_access`,
      );
    });
  });

  it("exchanges the code form-encoded with the verifier; validates the pair", async () => {
    const api = cloudflareApi();
    const grant = await exchangeCloudflareOauthCode(
      CREDS,
      { code: "c0de", redirectUri: `${REDIRECT_BASE}/ingress/cloudflare/oauth`, codeVerifier: "verifier" },
      api.fetchImpl,
    );
    expect(grant).toEqual({ accessToken: "cf-access-SECRET", refreshToken: "cf-refresh-OLD", expiresIn: 3600 });
    const call = api.calls.find((c) => c.url.includes("/oauth2/token"))!;
    const params = new URLSearchParams(call.body!);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code_verifier")).toBe("verifier");
    expect(params.get("client_secret")).toBe("cf-cs");
  });

  it("returns null on a refused exchange", async () => {
    const api = cloudflareApi({ exchangeFails: true });
    await expect(
      exchangeCloudflareOauthCode(CREDS, { code: "x", redirectUri: "y", codeVerifier: "z" }, api.fetchImpl),
    ).resolves.toBeNull();
  });

  it("surfaces the ROTATED refresh token on refresh, falling back to the input", async () => {
    const rotated = await refreshCloudflareAccess(CREDS, "cf-refresh-OLD", cloudflareApi().fetchImpl);
    expect(rotated).toEqual({ accessToken: "cf-access-SECRET", refreshToken: "cf-refresh-NEW", expiresIn: 3600 });

    const kept = await refreshCloudflareAccess(
      CREDS,
      "cf-refresh-OLD",
      cloudflareApi({ rotatedRefreshToken: null }).fetchImpl,
    );
    expect(kept).toEqual({ accessToken: "cf-access-SECRET", refreshToken: "cf-refresh-OLD", expiresIn: 3600 });

    await expect(
      refreshCloudflareAccess(CREDS, "cf-refresh-OLD", cloudflareApi({ refreshFails: true }).fetchImpl),
    ).resolves.toBeNull();
  });

  it("threads the credential's configured scope into the provider authorize URL", () => {
    const provider = createCloudflareProvider(cloudflareApi().fetchImpl, {
      ...CREDS,
      scope: "account:read com.cloudflare.api.account.api-tokens.write",
    });
    const url = new URL(
      provider.buildAuthorizeUrl!({
        state: "s",
        redirectUri: `${REDIRECT_BASE}/ingress/cloudflare/oauth`,
      }),
    );
    expect(url.searchParams.get("scope")).toBe(
      "account:read com.cloudflare.api.account.api-tokens.write offline_access",
    );
  });

  it("mints a child token from a REFRESHED access token, surfacing the rotated parent", async () => {
    const api = cloudflareApi();
    const provider = createCloudflareProvider(api.fetchImpl, CREDS);
    expect(provider.connectKind).toBe("oauth");
    expect(provider.buildAuthorizeUrl).toBeDefined();

    const outcome = await provider.broker!.mintCredential({
      template: "workers-deploy",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: "cf-refresh-OLD", externalRef: ACCOUNT_ID },
      mintRef: "orun/org_x/workers-deploy/mint_y",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.credential.token).toBe("cf-child-SECRET");
      expect(outcome.value.providerRef).toBe("child-token-id");
      // The refresh rotated the parent — the broker must re-envelope it.
      expect(outcome.value.rotatedParentCredential).toBe("cf-refresh-NEW");
    }
    // The child-token create used the ACCESS token as the bearer, never the
    // refresh token.
    const create = api.calls.find((c) => c.method === "POST" && c.url.includes(`/accounts/${ACCOUNT_ID}/tokens`))!;
    expect(create.auth).toBe("Bearer cf-access-SECRET");
    // A refresh happened before the create.
    const refresh = api.calls.find((c) => c.body?.includes("grant_type=refresh_token"));
    expect(refresh).toBeDefined();
  });

  it("omits rotatedParentCredential when the provider kept the parent", async () => {
    const api = cloudflareApi({ rotatedRefreshToken: null });
    const provider = createCloudflareProvider(api.fetchImpl, CREDS);
    const outcome = await provider.broker!.mintCredential({
      template: "account-read",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: "cf-refresh-OLD", externalRef: ACCOUNT_ID },
      mintRef: "orun/x/y/z",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.rotatedParentCredential).toBeUndefined();
  });

  it("maps a refused refresh to parent_grant_insufficient BEFORE any child create", async () => {
    const api = cloudflareApi({ refreshFails: true });
    const provider = createCloudflareProvider(api.fetchImpl, CREDS);
    const outcome = await provider.broker!.mintCredential({
      template: "workers-deploy",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: "cf-refresh-DEAD", externalRef: ACCOUNT_ID },
      mintRef: "orun/x/y/z",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "parent_grant_insufficient" });
    expect(api.calls.some((c) => c.method === "POST" && c.url.includes("/tokens"))).toBe(false);
  });

  it("refuses dns-edit without zoneIds BEFORE spending (rotating) the parent", async () => {
    const api = cloudflareApi();
    const provider = createCloudflareProvider(api.fetchImpl, CREDS);
    const outcome = await provider.broker!.mintCredential({
      template: "dns-edit",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: "cf-refresh-OLD", externalRef: ACCOUNT_ID },
      mintRef: "orun/x/y/z",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "provider_error" });
    // No refresh was spent on a doomed mint.
    expect(api.calls.some((c) => c.body?.includes("grant_type=refresh_token"))).toBe(false);
  });
});

// ── Registry posture selection ──────────────────────────────

describe("registry posture selection (D3)", () => {
  it("resolves an OAuth-kind adapter when the OAuth client is configured", () => {
    const configured = getConfiguredProvider(createEnv(), "cloudflare");
    expect(configured?.provider.connectKind).toBe("oauth");
    expect(configured?.provider.buildAuthorizeUrl).toBeDefined();
  });

  it("falls back to token-paste when no OAuth client is configured", () => {
    const env = createEnv({ CLOUDFLARE_OAUTH_CLIENT_ID: undefined, CLOUDFLARE_OAUTH_CLIENT_SECRET: undefined });
    const configured = getConfiguredProvider(env, "cloudflare");
    expect(configured?.provider.connectKind).toBe("token");
    expect(configured?.provider.buildAuthorizeUrl).toBeUndefined();
  });

  it("stays dormant without the custody key in either posture", () => {
    const env = createEnv({ SECRET_ENCRYPTION_KEY: undefined });
    expect(getConfiguredProvider(env, "cloudflare")).toBeNull();
  });
});

// ── Connect flow (authorize URL + PKCE custody) ─────────────

describe("POST …/integrations/cloudflare/connect (oauth posture)", () => {
  function connectRequest(): Request {
    return new Request("https://worker.test/v1/organizations/x/integrations/cloudflare/connect", {
      method: "POST",
      headers: { "content-length": "0" },
    });
  }

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
          id: "pkce-row", connection_id: params[1], kind: params[2], credential_class: params[3], ciphertext: params[4],
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      return [];
    });

    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "cloudflare", { executor });
    expect(res.status).toBe(201);
    const data = (await json(res)).data as Record<string, unknown>;
    expect((data.connection as Record<string, unknown>).provider).toBe("cloudflare");

    const authorizeUrl = new URL(data.installUrl as string);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("cf-cid");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${REDIRECT_BASE}/ingress/cloudflare/oauth`);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = authorizeUrl.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The enveloped verifier rides under the Cloudflare-specific PKCE kind and
    // decrypts back to something that hashes to the challenge.
    expect(custodyInsert[2]).toBe("cloudflare_pkce_verifier");
    const adapter = (await createEncryptionAdapter(KEY))!;
    const verifier = await adapter.decrypt(JSON.parse(custodyInsert[4] as string) as CiphertextEnvelope);
    await expect(computeCodeChallenge(verifier)).resolves.toBe(challenge);
  });

  it("gates on the CLOUDFLARE entitlement key", async () => {
    const env = createEnv({ BILLING_WORKER: billingFetcher(false, "disabled") });
    const { executor } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "cloudflare", { executor });
    expect(res.status).toBe(412);
    const details = ((await json(res)).error as Record<string, unknown>).details as Record<string, unknown>;
    expect(details.entitlementKey).toBe("feature.integrations.cloudflare");
  });
});

// ── OAuth callback (tenancy keystone + PKCE consume) ────────

describe("GET /ingress/cloudflare/oauth", () => {
  function callbackRequest(params: Record<string, string>): Request {
    const url = new URL("https://worker.test/ingress/cloudflare/oauth");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new Request(url.toString(), { method: "GET" });
  }

  async function mintState(overrides?: Partial<{ p: string; c: string; o: string }>): Promise<string> {
    return signConnectState(
      {
        n: "e".repeat(32),
        p: overrides?.p ?? "cloudflare",
        c: overrides?.c ?? CONNECTION_UUID,
        o: overrides?.o ?? ORG_UUID,
        exp: Date.now() + CONNECT_STATE_TTL_MS,
      },
      STATE_SECRET,
    );
  }

  it("fails a state-less callback closed with NO writes (no orphan path exists)", async () => {
    const api = cloudflareApi();
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleCloudflareOauthCallback(
      callbackRequest({ code: "c0de" }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(queries).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it("rejects a state minted for another provider", async () => {
    const api = cloudflareApi();
    const { executor } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      return [];
    });
    const res = await handleCloudflareOauthCallback(
      callbackRequest({ code: "c0de", state: await mintState({ p: "supabase" }) }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(api.calls).toHaveLength(0);
  });

  it("activates: verifier consumed, SERVICE-TOKEN custody (SI5 — refresh never stored), account facts, event", async () => {
    const verifier = "pkce-verifier-under-test-aaaaaaaaaaaaaaaaaaa";
    const api = cloudflareApi();
    const state = await mintState();
    const custody = await verifierCustodyRow(verifier);
    let credentialInsert: unknown[] = [];
    let factsInsert: unknown[] = [];
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) {
        return params[1] === "cloudflare_pkce_verifier" ? [custody] : [];
      }
      if (text.includes("SELECT * FROM integrations.cloudflare_accounts")) return []; // no prior binding
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        credentialInsert = params;
        return [{
          id: "cred-row", connection_id: CONNECTION_UUID, kind: params[2], credential_class: params[3], ciphertext: params[4],
          external_ref: params[6], created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("INSERT INTO integrations.cloudflare_accounts")) {
        factsInsert = params;
        return [{
          id: "cf-facts-row", connection_id: CONNECTION_UUID, account_external_id: ACCOUNT_ID,
          account_name: "Acme Infra", parent_token_ref: null, granted_policies: null,
          token_status: "active", parent_expires_at: null,
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("SET status = 'active'")) {
        return [pendingRow({
          status: "active", external_account_login: "Acme Infra",
          external_account_id: ACCOUNT_ID, external_account_type: "account",
          connected_at: NOW.toISOString(),
        })];
      }
      return [];
    });

    const res = await handleCloudflareOauthCallback(
      callbackRequest({ code: "c0de", state }),
      createEnv({ CONSOLE_BASE_URL: "https://app.orun.test" }), "req_1",
      { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Cloudflare connected");

    // The verifier custody row was read once and DELETED (consumed).
    const del = queries.find((q) => q.text.includes("DELETE FROM integrations.provider_credentials"));
    expect(del?.params).toEqual([CONNECTION_UUID, "cloudflare_pkce_verifier"]);

    // The exchange carried the DECRYPTED verifier and our exact redirect_uri.
    const exchange = api.calls.find((c) => c.body?.includes("grant_type=authorization_code"))!;
    const exchangeParams = new URLSearchParams(exchange.body!);
    expect(exchangeParams.get("code_verifier")).toBe(verifier);
    expect(exchangeParams.get("redirect_uri")).toBe(`${REDIRECT_BASE}/ingress/cloudflare/oauth`);

    // Custody: the PROVISIONED service token (SI2/SI5 — neither the refresh
    // nor the access token is ever stored), anchored to the account id.
    expect(credentialInsert[2]).toBe("cloudflare_service_token");
    expect(credentialInsert[6]).toBe(ACCOUNT_ID);
    const adapter = (await createEncryptionAdapter(KEY))!;
    const ciphertext = credentialInsert[4] as string;
    expect(ciphertext).not.toContain("cf-service-SECRET");
    expect(await adapter.decrypt(JSON.parse(ciphertext) as CiphertextEnvelope)).toBe("cf-service-SECRET");
    const everything = JSON.stringify(queries.map((q) => q.params));
    expect(everything).not.toContain("cf-refresh-OLD");

    // Account facts bound to the connection from OUR state, carrying the
    // service token's provider-side id.
    expect(factsInsert[1]).toBe(CONNECTION_UUID);
    expect(factsInsert[2]).toBe(ACCOUNT_ID);
    expect(factsInsert[4]).toBe("svc-token-id");

    // Activation used the org + connection from the state.
    const activate = queries.find((q) => q.text.includes("SET status = 'active'"))!;
    expect(activate.params[0]).toBe(ORG_UUID);
    expect(activate.params[1]).toBe(CONNECTION_UUID);
    expect(activate.params[5]).toBe("account");

    // Connected event never leaks the tokens.
    const eventJson = JSON.stringify(queries.filter((q) => q.text.includes("WITH inserted_event")).map((q) => q.params));
    expect(eventJson).toContain("cloudflare");
    expect(eventJson).not.toContain("cf-refresh-OLD");
    expect(eventJson).not.toContain("cf-access-SECRET");
  });

  it("fails closed when the PKCE verifier custody row is missing", async () => {
    const api = cloudflareApi();
    const { executor } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) return [];
      return [];
    });
    const res = await handleCloudflareOauthCallback(
      callbackRequest({ code: "c0de", state: await mintState() }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(400);
    // No exchange runs without a verifier.
    expect(api.calls.some((c) => c.body?.includes("grant_type=authorization_code"))).toBe(false);
  });
});
