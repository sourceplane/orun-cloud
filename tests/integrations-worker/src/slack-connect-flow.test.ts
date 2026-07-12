// IH1: the Slack OAuth v2 connect flow end-to-end — the oauth-kind twin of
// connect-flow.test.ts. Same keystone discipline: the org binding rides our
// signed single-use state; the code exchange is the provider-side check; a
// callback without a usable state records an ORPHANED workspace, fail closed.

import {
  handleConnectIntegration,
  handleRevokeIntegration,
} from "@integrations-worker/handlers/connections";
import { handleSlackOauthCallback } from "@integrations-worker/handlers/slack-oauth";
import { createEncryptionAdapter, type CiphertextEnvelope } from "@integrations-worker/encryption";
import { signConnectState, CONNECT_STATE_TTL_MS, hashStateNonce } from "@integrations-worker/state";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_UUID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = asUuid(ORG_UUID);
const STATE_SECRET = "state-secret";
const ENCRYPTION_KEY = "ab".repeat(32); // 64 hex chars = 256-bit key
const REDIRECT_BASE = "https://api-edge.test";
const NOW = new Date("2026-07-12T10:00:00Z");

// ── Fakes ────────────────────────────────────────────────────

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
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
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

function membershipFetcher(): Fetcher {
  return jsonFetcher({
    data: {
      memberships: [
        { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } },
      ],
    },
  });
}

function policyFetcher(allow: boolean): Fetcher {
  return jsonFetcher({ data: { allow, reason: allow ? "org_admin" : "no_matching_role" } });
}

function billingFetcher(allowed: boolean, reason?: string): Fetcher {
  return jsonFetcher({
    data: {
      allowed,
      orgId: `org_${ORG_UUID.replace(/-/g, "")}`,
      entitlementKey: "feature.integrations.slack",
      ...(reason ? { reason } : {}),
    },
  });
}

/** Fake Slack Web API: records oauth.v2.access / auth.revoke calls. */
function slackFetch(overrides?: {
  access?: Record<string, unknown> | null;
  revokeOk?: boolean;
}): { fetchImpl: (input: string, init?: RequestInit) => Promise<Response>; calls: { url: string; body: string | null; auth: string | null }[] } {
  const calls: { url: string; body: string | null; auth: string | null }[] = [];
  const accessBody =
    overrides?.access === null
      ? { ok: false, error: "invalid_code" }
      : {
          ok: true,
          access_token: "xoxb-test-token",
          token_type: "bot",
          scope: "chat:write,channels:read,commands",
          bot_user_id: "U0BOT",
          app_id: "A0APP",
          team: { id: "T0TEAM", name: "Acme Workspace" },
          enterprise: null,
          authed_user: { id: "U0INSTALLER" },
          ...(overrides?.access ?? {}),
        };
  const fetchImpl = (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: input,
      body: typeof init?.body === "string" ? init.body : null,
      auth: headers.get("authorization"),
    });
    if (input.includes("oauth.v2.access")) {
      return Promise.resolve(Response.json(accessBody));
    }
    if (input.includes("auth.revoke")) {
      return Promise.resolve(Response.json({ ok: overrides?.revokeOk ?? true, revoked: overrides?.revokeOk ?? true }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetchImpl, calls };
}

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: membershipFetcher(),
    POLICY_WORKER: policyFetcher(true),
    BILLING_WORKER: billingFetcher(true),
    INTEGRATIONS_STATE_SECRET: STATE_SECRET,
    SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
    OAUTH_REDIRECT_BASE_URL: REDIRECT_BASE,
    SLACK_APP_CLIENT_ID: "slack-cid",
    SLACK_APP_CLIENT_SECRET: "slack-cs",
    SLACK_APP_SIGNING_SECRET: "slack-signing",
    ...overrides,
  } as unknown as Env;
}

const ACTOR = {
  subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  subjectType: "user",
};

function pendingRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "slack",
    status: "pending",
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

function workspaceRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "ws-row",
    connection_id: CONNECTION_UUID,
    team_id: "T0TEAM",
    team_name: "Acme Workspace",
    enterprise_id: null,
    bot_user_id: "U0BOT",
    app_id: "A0APP",
    granted_scopes: ["chat:write"],
    installed_by_external_user: "U0INSTALLER",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

// ── Connect ─────────────────────────────────────────────────

describe("POST .../integrations/slack/connect", () => {
  function connectRequest(): Request {
    return new Request("https://worker.test/v1/organizations/x/integrations/slack/connect", {
      method: "POST",
      headers: { "content-length": "0" },
    });
  }

  it("denies via policy as 404 (no resource disclosure)", async () => {
    const env = createEnv({ POLICY_WORKER: policyFetcher(false) });
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "slack", { executor });
    expect(res.status).toBe(404);
    expect(queries).toHaveLength(0);
  });

  it("gates on the SLACK entitlement key, not GitHub's", async () => {
    const env = createEnv({ BILLING_WORKER: billingFetcher(false, "disabled") });
    const { executor } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "slack", { executor });
    expect(res.status).toBe(412);
    const error = (await json(res)).error as Record<string, unknown>;
    const details = error.details as Record<string, unknown>;
    expect(details.entitlementKey).toBe("feature.integrations.slack");
    expect(details.reason).toBe("disabled");
  });

  it("parks on D1 with 412/not_configured while the Slack App secrets are unset", async () => {
    const env = createEnv({ SLACK_APP_CLIENT_ID: undefined });
    const { executor } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "slack", { executor });
    expect(res.status).toBe(412);
    const error = (await json(res)).error as Record<string, unknown>;
    expect((error.details as Record<string, unknown>).gate).toBe("slack_app_registration");
  });

  it("parks with 412/not_configured when the public redirect origin is unset", async () => {
    // An oauth-kind provider cannot build its redirect_uri without the base.
    const env = createEnv({ OAUTH_REDIRECT_BASE_URL: undefined });
    const { executor } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "slack", { executor });
    expect(res.status).toBe(412);
    const error = (await json(res)).error as Record<string, unknown>;
    expect((error.details as Record<string, unknown>).reason).toBe("not_configured");
  });

  it("creates a pending slack connection and returns the authorize URL with signed state", async () => {
    const env = createEnv();
    let insertedParams: unknown[] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("INSERT INTO integrations.connections")) {
        insertedParams = params;
        return [pendingRow({ id: params[0] as string })];
      }
      return [];
    });

    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, "slack", { executor });
    expect(res.status).toBe(201);
    const data = (await json(res)).data as Record<string, unknown>;
    expect((data.connection as Record<string, unknown>).provider).toBe("slack");
    expect(insertedParams[2]).toBe("slack"); // provider column

    const authorizeUrl = new URL(data.installUrl as string);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("slack-cid");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${REDIRECT_BASE}/ingress/slack/oauth`);
    expect(authorizeUrl.searchParams.get("scope")).toContain("chat:write");
    const state = authorizeUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    // The DB stores the SHA-256 of the nonce, never the raw nonce or state.
    const storedNonceHash = insertedParams[7] as string;
    expect(storedNonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state).not.toContain(storedNonceHash);
  });
});

// ── OAuth callback (tenancy keystone, oauth-kind) ───────────

describe("GET /ingress/slack/oauth", () => {
  function callbackRequest(params: Record<string, string>): Request {
    const url = new URL("https://worker.test/ingress/slack/oauth");
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
        p: overrides?.p ?? "slack",
        c: overrides?.c ?? CONNECTION_UUID,
        o: overrides?.o ?? ORG_UUID,
        exp: overrides?.exp ?? Date.now() + CONNECT_STATE_TTL_MS,
      },
      STATE_SECRET,
    );
    return { state, nonce };
  }

  it("reports a user-cancelled authorization without touching the DB", async () => {
    const env = createEnv();
    const { fetchImpl } = slackFetch();
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleSlackOauthCallback(
      callbackRequest({ error: "access_denied" }),
      env,
      "req_1",
      { executor, fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it("records an unsolicited grant (no state) as an orphaned workspace, fail closed", async () => {
    const env = createEnv();
    const { fetchImpl, calls } = slackFetch();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("INSERT INTO integrations.slack_workspaces")) {
        return [workspaceRow({ connection_id: null })];
      }
      return [];
    });

    const res = await handleSlackOauthCallback(callbackRequest({ code: "c0de" }), env, "req_1", {
      executor,
      fetchImpl,
    });
    expect(res.status).toBe(400);
    const orphanInsert = queries.find((q) =>
      q.text.includes("INSERT INTO integrations.slack_workspaces"),
    );
    expect(orphanInsert).toBeDefined();
    expect(orphanInsert!.params[1]).toBeNull(); // connection_id NULL = orphaned
    // The orphaned grant's token was revoked provider-side, and nothing activated.
    expect(calls.some((c) => c.url.includes("auth.revoke"))).toBe(true);
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
    expect(queries.some((q) => q.text.includes("provider_credentials"))).toBe(false);
  });

  it("treats replayed/expired state (nonce no longer consumable) as orphaned", async () => {
    const env = createEnv();
    const { fetchImpl } = slackFetch();
    const { state } = await mintState();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return []; // already consumed
      if (text.includes("INSERT INTO integrations.slack_workspaces")) {
        return [workspaceRow({ connection_id: null })];
      }
      return [];
    });

    const res = await handleSlackOauthCallback(
      callbackRequest({ code: "c0de", state }),
      env,
      "req_1",
      { executor, fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(queries.some((q) => q.text.includes("INSERT INTO integrations.slack_workspaces"))).toBe(true);
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });

  it("rejects state whose payload disagrees with the consumed row (cross-org redemption)", async () => {
    const env = createEnv();
    const { fetchImpl } = slackFetch();
    const { state } = await mintState({ o: OTHER_ORG_UUID });
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("INSERT INTO integrations.slack_workspaces")) {
        return [workspaceRow({ connection_id: null })];
      }
      return [];
    });

    const res = await handleSlackOauthCallback(
      callbackRequest({ code: "c0de", state }),
      env,
      "req_1",
      { executor, fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });

  it("fails closed when Slack refuses the code exchange", async () => {
    const env = createEnv();
    const { fetchImpl } = slackFetch({ access: null });
    const { state, nonce } = await mintState();
    const expectedHash = await hashStateNonce(nonce);
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("SET state_nonce_hash = NULL")) {
        expect(params[0]).toBe(expectedHash);
        return [pendingRow()];
      }
      return [];
    });

    const res = await handleSlackOauthCallback(
      callbackRequest({ code: "bad-c0de", state }),
      env,
      "req_1",
      { executor, fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Verification failed");
    expect(queries.some((q) => q.text.includes("provider_credentials"))).toBe(false);
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });

  it("activates the pending connection: custody envelope, workspace facts, event", async () => {
    const env = createEnv();
    const { fetchImpl, calls } = slackFetch();
    const { state } = await mintState();

    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        return [
          {
            id: "cred-row",
            connection_id: CONNECTION_UUID,
            kind: "slack_bot_token",
            ciphertext: "{}",
            scopes: null,
            external_ref: "T0TEAM",
            expires_at: null,
            rotated_at: null,
            created_at: NOW.toISOString(),
            updated_at: NOW.toISOString(),
          },
        ];
      }
      if (text.includes("INSERT INTO integrations.slack_workspaces")) return [workspaceRow()];
      if (text.includes("SET status = 'active'")) {
        return [
          pendingRow({
            status: "active",
            external_account_login: "Acme Workspace",
            external_account_id: "T0TEAM",
            external_account_type: "workspace",
            connected_at: NOW.toISOString(),
          }),
        ];
      }
      if (text.includes("INSERT INTO")) return [{ id: "evt" }]; // events + audit
      return [];
    });

    const res = await handleSlackOauthCallback(
      callbackRequest({ code: "c0de", state }),
      env,
      "req_1",
      { executor, fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Slack connected");

    // The exchange carried our exact redirect_uri (Slack verifies the pair).
    const exchange = calls.find((c) => c.url.includes("oauth.v2.access"));
    expect(exchange).toBeDefined();
    expect(exchange!.body).toContain(encodeURIComponent(`${REDIRECT_BASE}/ingress/slack/oauth`));

    // Custody: the stored ciphertext is a real AES-256-GCM envelope of the bot
    // token — decryptable with the environment key, never the raw token.
    const credentialInsert = queries.find((q) =>
      q.text.includes("INSERT INTO integrations.provider_credentials"),
    );
    expect(credentialInsert).toBeDefined();
    expect(credentialInsert!.params[2]).toBe("slack_bot_token");
    const ciphertext = credentialInsert!.params[3] as string;
    expect(ciphertext).not.toContain("xoxb-test-token");
    const envelope = JSON.parse(ciphertext) as CiphertextEnvelope;
    expect(envelope.alg).toBe("AES-256-GCM");
    const adapter = await createEncryptionAdapter(ENCRYPTION_KEY);
    expect(await adapter!.decrypt(envelope)).toBe("xoxb-test-token");
    expect(credentialInsert!.params[5]).toBe("T0TEAM"); // external_ref = team id

    // Workspace facts bound to the connection from OUR state.
    const workspaceInsert = queries.find((q) =>
      q.text.includes("INSERT INTO integrations.slack_workspaces"),
    );
    expect(workspaceInsert!.params[1]).toBe(CONNECTION_UUID);
    expect(workspaceInsert!.params[2]).toBe("T0TEAM");

    // Activation used the org + connection from the state, team facts from Slack.
    const activate = queries.find((q) => q.text.includes("SET status = 'active'"));
    expect(activate).toBeDefined();
    expect(activate!.params[0]).toBe(ORG_UUID);
    expect(activate!.params[1]).toBe(CONNECTION_UUID);
  });

  it("refuses to flip a workspace already bound to another connection", async () => {
    const env = createEnv();
    const { fetchImpl } = slackFetch();
    const { state } = await mintState();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        return [{ id: "cred-row", connection_id: CONNECTION_UUID, kind: "slack_bot_token", ciphertext: "{}", created_at: NOW.toISOString(), updated_at: NOW.toISOString() }];
      }
      if (text.includes("INSERT INTO integrations.slack_workspaces")) {
        // COALESCE keeps the existing owner: the row comes back bound elsewhere.
        return [workspaceRow({ connection_id: "44444444-4444-4444-8444-444444444444" })];
      }
      return [];
    });

    const res = await handleSlackOauthCallback(
      callbackRequest({ code: "c0de", state }),
      env,
      "req_1",
      { executor, fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Already connected");
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });

  it("parks with a not-configured popup when the encryption key is unset", async () => {
    const env = createEnv({ SECRET_ENCRYPTION_KEY: undefined });
    const { fetchImpl } = slackFetch();
    const { state } = await mintState();
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleSlackOauthCallback(
      callbackRequest({ code: "c0de", state }),
      env,
      "req_1",
      { executor, fetchImpl },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Not configured");
    expect(queries).toHaveLength(0);
  });
});

// ── Revoke (custody zeroize + provider-side auth.revoke) ────

describe("DELETE .../integrations/{id} — slack", () => {
  it("zeroizes the custody envelope and revokes the token with Slack", async () => {
    // A REAL envelope so the handler can decrypt-then-revoke.
    const adapter = await createEncryptionAdapter(ENCRYPTION_KEY);
    const envelope = await adapter!.encrypt("xoxb-live-token");

    const { fetchImpl, calls } = slackFetch();
    const env = createEnv();
    let status = "active";
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SELECT * FROM integrations.connections")) {
        return [pendingRow({ status, external_account_login: "Acme Workspace" })];
      }
      if (text.includes("SET status = $3")) {
        status = "revoked";
        return [pendingRow({ status: "revoked", revoked_at: NOW.toISOString() })];
      }
      if (text.includes("SELECT * FROM integrations.provider_credentials")) {
        return [
          {
            id: "cred-row",
            connection_id: CONNECTION_UUID,
            kind: "slack_bot_token",
            ciphertext: JSON.stringify(envelope),
            scopes: null,
            external_ref: "T0TEAM",
            expires_at: null,
            rotated_at: null,
            created_at: NOW.toISOString(),
            updated_at: NOW.toISOString(),
          },
        ];
      }
      return [{ id: "x" }];
    });

    const res = await handleRevokeIntegration(env, "req_1", ACTOR, ORG_ID, asUuid(CONNECTION_UUID), {
      executor,
      fetchImpl,
    });
    expect(res.status).toBe(200);

    // Provider-side revoke carried the DECRYPTED token.
    const revokeCall = calls.find((c) => c.url.includes("auth.revoke"));
    expect(revokeCall).toBeDefined();
    expect(revokeCall!.auth).toBe("Bearer xoxb-live-token");

    // Custody zeroize: every provider_credentials row for the connection.
    expect(
      queries.some((q) => q.text.includes("DELETE FROM integrations.provider_credentials")),
    ).toBe(true);
  });
});
