// SI2 (sub-epics/service-identity-bootstrap): Cloudflare service-identity
// provisioning — "OAuth establishes trust, service identities operate".
// Rules under test:
//   * provisionServiceIdentity creates the durable ACCOUNT-OWNED token (no
//     expiry, template-union + token-administration grant) from the bootstrap
//     access token, deny-by-default: a bootstrap grant that cannot cover the
//     union is `bootstrap_grant_insufficient`, never a partial identity.
//   * The OAuth callback prefers the service identity: custody holds ONLY
//     `cloudflare_service_token` (refresh custody deleted, refresh token
//     never stored); the SI-D1 fallback stores refresh custody exactly as
//     shipped when the grant cannot create tokens.
//   * Mint/revoke posture dispatches on the parent's custody KIND — an
//     upgraded connection never re-enters the refresh flow even in an
//     OAuth-configured environment.
//   * Rotation rolls the token value in place (same provider-side id).

import { handleCloudflareOauthCallback } from "@integrations-worker/handlers/cloudflare-oauth";
import {
  createCloudflareProvider,
  provisionCloudflareServiceIdentity,
  rotateCloudflareServiceIdentity,
  serviceIdentityPermissionGroups,
} from "@integrations-worker/providers/cloudflare";
import { createEncryptionAdapter, type CiphertextEnvelope } from "@integrations-worker/encryption";
import { signConnectState, CONNECT_STATE_TTL_MS } from "@integrations-worker/state";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const STATE_SECRET = "state-secret";
const KEY = "cd".repeat(32);
const REDIRECT_BASE = "https://api-edge.test";
const ACCOUNT_ID = "9a7806061c88ada191ed06f989cc3dac";
const NOW = new Date("2026-07-17T14:00:00Z");
const CREDS = { clientId: "cf-cid", clientSecret: "cf-cs" };

/** Every permission group the service identity needs, as the provider fake's
 *  catalog — the happy-path bootstrap grant can see all of them. */
const ALL_GROUPS = serviceIdentityPermissionGroups().map((name, i) => ({
  id: `pg-${i}`,
  name,
}));

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

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: jsonFetcher({ data: { memberships: [] } }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
    INTEGRATIONS_STATE_SECRET: STATE_SECRET,
    SECRET_ENCRYPTION_KEY: KEY,
    OAUTH_REDIRECT_BASE_URL: REDIRECT_BASE,
    CLOUDFLARE_OAUTH_CLIENT_ID: CREDS.clientId,
    CLOUDFLARE_OAUTH_CLIENT_SECRET: CREDS.clientSecret,
    ...overrides,
  } as unknown as Env;
}

/** Fake Cloudflare API: OAuth exchange, account discovery, permission groups
 *  (full catalog by default), account-token create (service identity AND
 *  child mints), token-value roll. Records every call. */
function cloudflareApi(overrides?: {
  groups?: Array<Record<string, unknown>>;
  createStatus?: number;
  rollFails?: boolean;
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
        return Response.json({
          access_token: "cf-access-SECRET",
          refresh_token: "cf-refresh-OLD",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      return Response.json({
        access_token: "cf-access-SECRET",
        refresh_token: "cf-refresh-NEW",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (input.includes("/accounts?")) {
      return Response.json({ success: true, result: [{ id: ACCOUNT_ID, name: "Acme Infra" }] });
    }
    if (input.includes("/user/tokens/permission_groups")) {
      return Response.json({ success: true, result: overrides?.groups ?? ALL_GROUPS });
    }
    if (input.includes(`/tokens/svc-token-id/value`) && (init?.method ?? "GET") === "PUT") {
      if (overrides?.rollFails) {
        return Response.json({ success: false, errors: [{ message: "nope" }] }, { status: 400 });
      }
      return Response.json({ success: true, result: "cf-service-ROLLED" });
    }
    if (input.includes(`/accounts/${ACCOUNT_ID}/tokens`) && (init?.method ?? "GET") === "POST") {
      if (overrides?.createStatus) {
        return Response.json(
          { success: false, errors: [{ message: "denied" }] },
          { status: overrides.createStatus },
        );
      }
      const body = JSON.parse(String(init?.body)) as { name?: string };
      // The service identity is the org-named durable token; child mints are
      // the mint-ref-named ones.
      return String(body.name).endsWith("/service")
        ? Response.json({ success: true, result: { id: "svc-token-id", value: "cf-service-SECRET" } })
        : Response.json({ success: true, result: { id: "child-token-id", value: "cf-child-SECRET" } });
    }
    if ((init?.method ?? "GET") === "DELETE") {
      return Response.json({ success: true, result: { id: "deleted" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

// ── Provisioning unit ───────────────────────────────────────

describe("provisionCloudflareServiceIdentity (SI2)", () => {
  const input = {
    bootstrapCredential: "cf-access-SECRET",
    externalRef: ACCOUNT_ID,
    identityRef: "orun/org_11111111111141118111111111111111/service",
    nowMs: NOW.getTime(),
  };

  it("creates the durable account-owned token: template union + token admin, NO expiry", async () => {
    const api = cloudflareApi();
    const outcome = await provisionCloudflareServiceIdentity(input, api.fetchImpl);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.kind).toBe("cloudflare_service_token");
    expect(outcome.value.credential).toBe("cf-service-SECRET");
    // Custody anchors on the ACCOUNT; the token's own id is the facts ref.
    expect(outcome.value.externalRef).toBe(ACCOUNT_ID);
    expect(outcome.value.providerRef).toBe("svc-token-id");
    expect(outcome.value.expiresAt).toBeNull();

    const create = api.calls.find((c) => c.method === "POST" && c.url.includes("/tokens"))!;
    const body = JSON.parse(create.body!) as {
      name: string;
      expires_on?: unknown;
      policies: Array<{ permission_groups: Array<{ id: string }>; resources: Record<string, string> }>;
    };
    expect(body.name).toBe(input.identityRef);
    // Durable: the platform rotates it; no provider-side expiry.
    expect(body.expires_on).toBeUndefined();
    // The grant covers every published template plus token administration.
    expect(body.policies[0]!.permission_groups).toHaveLength(ALL_GROUPS.length);
    expect(body.policies[0]!.resources).toEqual({
      [`com.cloudflare.api.account.${ACCOUNT_ID}`]: "*",
    });
  });

  it("refuses (bootstrap_grant_insufficient) when the grant cannot cover the union — no partial identity", async () => {
    const api = cloudflareApi({ groups: ALL_GROUPS.slice(0, 3) });
    const outcome = await provisionCloudflareServiceIdentity(input, api.fetchImpl);
    expect(outcome).toMatchObject({ ok: false, reason: "bootstrap_grant_insufficient" });
    // Deny-by-default: nothing was created.
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("maps a 403 token-create onto bootstrap_grant_insufficient (the SI-D1 branch)", async () => {
    const api = cloudflareApi({ createStatus: 403 });
    const outcome = await provisionCloudflareServiceIdentity(input, api.fetchImpl);
    expect(outcome).toMatchObject({ ok: false, reason: "bootstrap_grant_insufficient" });
  });

  it("rolls the token value in place — same provider-side id, new secret", async () => {
    const api = cloudflareApi();
    const outcome = await rotateCloudflareServiceIdentity(
      {
        current: { credential: "cf-service-SECRET", externalRef: ACCOUNT_ID, kind: "cloudflare_service_token" },
        providerRef: "svc-token-id",
        nowMs: NOW.getTime(),
      },
      api.fetchImpl,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.credential).toBe("cf-service-ROLLED");
    expect(outcome.value.providerRef).toBe("svc-token-id");
    const roll = api.calls.find((c) => c.method === "PUT")!;
    expect(roll.url).toContain(`/accounts/${ACCOUNT_ID}/tokens/svc-token-id/value`);
    expect(roll.auth).toBe("Bearer cf-service-SECRET");
  });
});

// ── Kind-dispatched mint posture ────────────────────────────

describe("mint posture dispatches on custody kind (SI2)", () => {
  it("service-token custody is the API bearer directly — NO refresh call, even with an OAuth client configured", async () => {
    const api = cloudflareApi();
    const provider = createCloudflareProvider(api.fetchImpl, CREDS);
    const outcome = await provider.broker!.mintCredential({
      template: "workers-deploy",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: {
        credential: "cf-service-SECRET",
        externalRef: ACCOUNT_ID,
        kind: "cloudflare_service_token",
      },
      mintRef: "orun/org_x/workers-deploy/mint_y",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.credential.token).toBe("cf-child-SECRET");
    // The deprecated refresh flow never ran; the service token was the bearer.
    expect(api.calls.some((c) => c.url.includes("/oauth2/token"))).toBe(false);
    const create = api.calls.find((c) => c.method === "POST")!;
    expect(create.auth).toBe("Bearer cf-service-SECRET");
  });

  it("refresh-token custody still refreshes first (un-migrated connection)", async () => {
    const api = cloudflareApi();
    const provider = createCloudflareProvider(api.fetchImpl, CREDS);
    const outcome = await provider.broker!.mintCredential({
      template: "workers-deploy",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: {
        credential: "cf-refresh-OLD",
        externalRef: ACCOUNT_ID,
        kind: "cloudflare_refresh_token",
      },
      mintRef: "orun/org_x/workers-deploy/mint_y",
    });
    expect(outcome.ok).toBe(true);
    expect(api.calls.some((c) => c.url.includes("/oauth2/token"))).toBe(true);
    // The rotated refresh token surfaces for re-envelope, as shipped.
    if (outcome.ok) expect(outcome.value.rotatedParentCredential).toBe("cf-refresh-NEW");
  });

  it("revoke with service-token custody deletes directly — no refresh", async () => {
    const api = cloudflareApi();
    const provider = createCloudflareProvider(api.fetchImpl, CREDS);
    const revoked = await provider.broker!.revokeCredential("child-token-id", NOW.getTime(), {
      credential: "cf-service-SECRET",
      externalRef: ACCOUNT_ID,
      kind: "cloudflare_service_token",
    });
    expect(revoked).toBe(true);
    expect(api.calls.some((c) => c.url.includes("/oauth2/token"))).toBe(false);
    const del = api.calls.find((c) => c.method === "DELETE")!;
    expect(del.auth).toBe("Bearer cf-service-SECRET");
  });
});

// ── OAuth callback: provision-first custody ─────────────────

describe("GET /ingress/cloudflare/oauth establishes service-identity custody (SI2)", () => {
  function callbackRequest(params: Record<string, string>): Request {
    const url = new URL("https://worker.test/ingress/cloudflare/oauth");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new Request(url.toString(), { method: "GET" });
  }

  async function mintState(): Promise<string> {
    return signConnectState(
      {
        n: "e".repeat(32),
        p: "cloudflare",
        c: CONNECTION_UUID,
        o: ORG_UUID,
        exp: Date.now() + CONNECT_STATE_TTL_MS,
      },
      STATE_SECRET,
    );
  }

  function pendingRow(): Record<string, unknown> {
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
    };
  }

  async function verifierCustodyRow(): Promise<Record<string, unknown>> {
    const adapter = (await createEncryptionAdapter(KEY))!;
    const envelope = await adapter.encrypt("pkce-verifier-under-test-aaaaaaaaaaaaaaaaaaa");
    return {
      id: "pkce-row",
      connection_id: CONNECTION_UUID,
      kind: "cloudflare_pkce_verifier",
      ciphertext: JSON.stringify(envelope),
      scopes: null,
      external_ref: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
  }

  interface CallbackHarness {
    executor: SqlExecutor;
    queries: QueryRecord[];
    custodyInserts: unknown[][];
    factsInserts: unknown[][];
  }

  async function callbackHarness(): Promise<CallbackHarness> {
    const custody = await verifierCustodyRow();
    const custodyInserts: unknown[][] = [];
    const factsInserts: unknown[][] = [];
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) {
        return params[1] === "cloudflare_pkce_verifier" ? [custody] : [];
      }
      if (text.includes("SELECT * FROM integrations.cloudflare_accounts")) return [];
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        custodyInserts.push(params);
        return [{
          id: "cred-row", connection_id: CONNECTION_UUID, kind: params[2], credential_class: params[3],
          ciphertext: params[4], external_ref: params[6],
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("INSERT INTO integrations.cloudflare_accounts")) {
        factsInserts.push(params);
        return [{
          id: "cf-facts-row", connection_id: CONNECTION_UUID, account_external_id: ACCOUNT_ID,
          account_name: "Acme Infra", parent_token_ref: params[4], granted_policies: null,
          token_status: "active", parent_expires_at: null,
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("SET status = 'active'")) {
        return [{ ...pendingRow(), status: "active", connected_at: NOW.toISOString() }];
      }
      return [];
    });
    return { executor, queries, custodyInserts, factsInserts };
  }

  it("provisions the service token: custody = cloudflare_service_token, refresh NEVER stored, facts carry the token id", async () => {
    const api = cloudflareApi();
    const h = await callbackHarness();
    const res = await handleCloudflareOauthCallback(
      callbackRequest({ code: "c0de", state: await mintState() }),
      createEnv(), "req_1", { executor: h.executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Cloudflare connected");

    // Exactly ONE custody insert: the service token, anchored to the account.
    expect(h.custodyInserts).toHaveLength(1);
    const insert = h.custodyInserts[0]!;
    expect(insert[2]).toBe("cloudflare_service_token");
    expect(insert[3]).toBe("infrastructure");
    expect(insert[6]).toBe(ACCOUNT_ID);
    const adapter = (await createEncryptionAdapter(KEY))!;
    expect(await adapter.decrypt(JSON.parse(insert[4] as string) as CiphertextEnvelope)).toBe(
      "cf-service-SECRET",
    );

    // Identity credentials did not outlive provisioning: the refresh token
    // was never enveloped anywhere.
    const everything = JSON.stringify(h.queries.map((q) => q.params));
    expect(everything).not.toContain("cf-refresh-OLD");
    expect(everything).not.toContain("cf-access-SECRET");
    // Any stale refresh custody was dropped (upgrade-on-reauth semantics).
    expect(
      h.queries.some(
        (q) =>
          q.text.includes("DELETE FROM integrations.provider_credentials") &&
          q.params[1] === "cloudflare_refresh_token",
      ),
    ).toBe(true);

    // Facts carry the service token's provider-side id for verify/rotate.
    expect(h.factsInserts[0]![4]).toBe("svc-token-id");

    // The provisioned token is org-named for the IH9 sweep.
    const create = api.calls.find(
      (c) => c.method === "POST" && c.url.includes("/tokens") && c.body?.includes("/service"),
    )!;
    expect(JSON.parse(create.body!).name).toBe(
      `orun/org_${ORG_UUID.replace(/-/g, "")}/service`,
    );

    // Rollout observability: the CONNECTED event names the custody class.
    const eventJson = JSON.stringify(
      h.queries.filter((q) => q.text.includes("WITH inserted_event")).map((q) => q.params),
    );
    expect(eventJson).toContain("service_token");
  });

  it("fails closed with GUIDANCE when the bootstrap grant cannot create tokens (SI5 — no refresh fallback)", async () => {
    const api = cloudflareApi({ groups: ALL_GROUPS.slice(0, 3) });
    const h = await callbackHarness();
    const res = await handleCloudflareOauthCallback(
      callbackRequest({ code: "c0de", state: await mintState() }),
      createEnv(), "req_1", { executor: h.executor, fetchImpl: api.fetchImpl },
    );
    // The connect FAILS — user-derived custody is never written (SI5), and
    // the popup names the remediation instead of a generic error.
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain("cannot create API tokens");
    expect(page).toContain("pasting an account API token");

    expect(h.custodyInserts).toHaveLength(0);
    expect(h.factsInserts).toHaveLength(0);
    // The connection was never activated.
    expect(h.queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });
});
