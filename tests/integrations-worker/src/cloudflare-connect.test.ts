// IH5: the Cloudflare adapter goes live — token-paste connect (the third
// connect kind: verify → custody → facts → activate, one request, no popup)
// and real child-token minting through the IH4 broker core.

import { handleConnectIntegration } from "@integrations-worker/handlers/connections";
import { handleMintCredential } from "@integrations-worker/handlers/credential-broker";
import {
  discoverCloudflareAccount,
  createCloudflareProvider,
  verifyCloudflareParentToken,
} from "@integrations-worker/providers/cloudflare";
import { createEncryptionAdapter } from "@integrations-worker/encryption";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = asUuid(ORG_UUID);
const KEY = "cd".repeat(32);
const PARENT_TOKEN = "cf-parent-token-abcdefghijklmnop";
const ACCOUNT_ID = "9a7806061c88ada191ed06f989cc3dac";
const NOW = new Date("2026-07-12T14:00:00Z");

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
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [
          { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } },
        ],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
    BILLING_WORKER: {
      fetch: async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { entitlementKey: string; orgId: string };
        return Response.json({
          data: {
            allowed: true,
            orgId: body.orgId,
            entitlementKey: body.entitlementKey,
            valueType: "quantity",
            limitValue: null,
            source: "plan",
            subscriptionId: "s",
          },
        });
      },
      connect() {
        throw new Error("not implemented");
      },
    } as unknown as Fetcher,
    INTEGRATIONS_STATE_SECRET: "state-secret",
    SECRET_ENCRYPTION_KEY: KEY,
    ...overrides,
  } as unknown as Env;
}

const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

/** Fake Cloudflare API covering verify / accounts / permission groups /
 *  token create + delete. Records every call. */
function cloudflareApi(overrides?: {
  verifyStatus?: string;
  verifyFails?: boolean;
  accounts?: Array<Record<string, unknown>>;
  groups?: Array<Record<string, unknown>>;
  createStatus?: number;
}): {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; method: string; body: Record<string, unknown> | null; auth: string | null }>;
} {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null; auth: string | null }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (input.includes("/user/tokens/verify")) {
      if (overrides?.verifyFails) return Response.json({ success: false }, { status: 401 });
      return Response.json({
        success: true,
        result: { id: "parent-token-id", status: overrides?.verifyStatus ?? "active", expires_on: "2026-12-01T00:00:00Z" },
      });
    }
    if (input.includes("/accounts?")) {
      return Response.json({
        success: true,
        result: overrides?.accounts ?? [{ id: ACCOUNT_ID, name: "Acme Infra" }],
      });
    }
    if (input.includes("/user/tokens/permission_groups")) {
      return Response.json({
        success: true,
        result:
          overrides?.groups ??
          [
            { id: "pg-1", name: "Workers Scripts Write" },
            { id: "pg-2", name: "Workers KV Storage Write" },
            { id: "pg-3", name: "Account Settings Read" },
            { id: "pg-4", name: "DNS Write" },
          ],
      });
    }
    if (input.includes(`/accounts/${ACCOUNT_ID}/tokens`) && (init?.method ?? "GET") === "POST") {
      if (overrides?.createStatus) {
        return Response.json(
          { success: false, errors: [{ message: "denied" }] },
          { status: overrides.createStatus },
        );
      }
      return Response.json({
        success: true,
        result: { id: "child-token-id", value: "cf-child-SECRET" },
      });
    }
    if ((init?.method ?? "GET") === "DELETE") {
      return Response.json({ success: true, result: { id: "child-token-id" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

// ── Adapter units ───────────────────────────────────────────

describe("cloudflare adapter (IH5)", () => {
  it("verifies the parent token and discovers the account", async () => {
    const { fetchImpl } = cloudflareApi();
    const verification = await verifyCloudflareParentToken(PARENT_TOKEN, fetchImpl);
    expect(verification).toEqual({
      tokenId: "parent-token-id",
      status: "active",
      expiresOn: "2026-12-01T00:00:00Z",
    });
    const account = await discoverCloudflareAccount(PARENT_TOKEN, fetchImpl);
    expect(account).toEqual({ accountExternalId: ACCOUNT_ID, accountName: "Acme Infra" });
  });

  it("fails closed when Cloudflare refuses the token", async () => {
    const { fetchImpl } = cloudflareApi({ verifyFails: true });
    await expect(verifyCloudflareParentToken("bad", fetchImpl)).resolves.toBeNull();
  });

  it("mints a child token: named mintRef, clamped expiry, template policies", async () => {
    const api = cloudflareApi();
    const provider = createCloudflareProvider(api.fetchImpl);
    const outcome = await provider.broker!.mintCredential({
      template: "workers-deploy",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: PARENT_TOKEN, externalRef: ACCOUNT_ID },
      mintRef: "orun/org_x/workers-deploy/mint_y",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.credential.token).toBe("cf-child-SECRET");
      expect(outcome.value.providerRef).toBe("child-token-id");
      expect(outcome.value.expiresAt).toEqual(new Date(NOW.getTime() + 900_000));
    }
    const create = api.calls.find((c) => c.method === "POST");
    expect(create).toBeDefined();
    expect(create!.auth).toBe(`Bearer ${PARENT_TOKEN}`);
    expect(create!.body!.name).toBe("orun/org_x/workers-deploy/mint_y");
    expect(create!.body!.expires_on).toBe(new Date(NOW.getTime() + 900_000).toISOString());
    const policy = (create!.body!.policies as Array<Record<string, unknown>>)[0]!;
    expect(policy.resources).toEqual({ [`com.cloudflare.api.account.${ACCOUNT_ID}`]: "*" });
    expect(policy.permission_groups).toEqual([{ id: "pg-1" }, { id: "pg-2" }, { id: "pg-3" }]);
  });

  it("denies a template the parent grant cannot cover (missing groups)", async () => {
    const api = cloudflareApi({ groups: [{ id: "pg-3", name: "Account Settings Read" }] });
    const provider = createCloudflareProvider(api.fetchImpl);
    const outcome = await provider.broker!.mintCredential({
      template: "workers-deploy",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: PARENT_TOKEN, externalRef: ACCOUNT_ID },
      mintRef: "orun/x/y/z",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "parent_grant_insufficient" });
  });

  it("maps a 403 on token creation to parent_grant_insufficient", async () => {
    const api = cloudflareApi({ createStatus: 403 });
    const provider = createCloudflareProvider(api.fetchImpl);
    const outcome = await provider.broker!.mintCredential({
      template: "account-read",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: PARENT_TOKEN, externalRef: ACCOUNT_ID },
      mintRef: "orun/x/y/z",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "parent_grant_insufficient" });
  });

  it("scopes dns-edit to the named zones and refuses without them", async () => {
    const api = cloudflareApi();
    const provider = createCloudflareProvider(api.fetchImpl);
    const zoneId = "f".repeat(32);
    const ok = await provider.broker!.mintCredential({
      template: "dns-edit",
      params: { zoneIds: [zoneId] },
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: PARENT_TOKEN, externalRef: ACCOUNT_ID },
      mintRef: "orun/x/y/z",
    });
    expect(ok.ok).toBe(true);
    const create = api.calls.find((c) => c.method === "POST");
    const policy = (create!.body!.policies as Array<Record<string, unknown>>)[0]!;
    expect(policy.resources).toEqual({ [`com.cloudflare.api.account.zone.${zoneId}`]: "*" });

    const missing = await provider.broker!.mintCredential({
      template: "dns-edit",
      params: {},
      ttlSeconds: 900,
      nowMs: NOW.getTime(),
      parent: { credential: PARENT_TOKEN, externalRef: ACCOUNT_ID },
      mintRef: "orun/x/y/z",
    });
    expect(missing).toMatchObject({ ok: false, reason: "provider_error" });
  });

  it("revokes a child token account-side with the parent", async () => {
    const api = cloudflareApi();
    const provider = createCloudflareProvider(api.fetchImpl);
    await expect(
      provider.broker!.revokeCredential("child-token-id", NOW.getTime(), {
        credential: PARENT_TOKEN,
        externalRef: ACCOUNT_ID,
      }),
    ).resolves.toBe(true);
    const del = api.calls.find((c) => c.method === "DELETE");
    expect(del!.url).toContain(`/accounts/${ACCOUNT_ID}/tokens/child-token-id`);
  });
});

// ── Token-paste connect ─────────────────────────────────────

describe("POST …/integrations/cloudflare/connect (token paste)", () => {
  function connectRequest(body: Record<string, unknown>): Request {
    return new Request("https://worker.test/v1/organizations/x/integrations/cloudflare/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function connectionRow(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      id: CONNECTION_UUID,
      org_id: ORG_UUID,
      provider: "cloudflare",
      status: "pending",
      scope: "account",
      share_mode: "auto",
      display_name: null,
      created_by: "usr_abc",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      ...overrides,
    };
  }

  it("422s a malformed paste without calling Cloudflare", async () => {
    const api = cloudflareApi();
    const { executor } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(
      connectRequest({ parentToken: "short" }),
      createEnv(), "req_1", ACTOR, ORG_ID, "cloudflare", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(422);
    expect(api.calls).toHaveLength(0);
  });

  it("412s when Cloudflare refuses the token, before any write", async () => {
    const api = cloudflareApi({ verifyFails: true });
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(
      connectRequest({ parentToken: PARENT_TOKEN }),
      createEnv(), "req_1", ACTOR, ORG_ID, "cloudflare", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(412);
    const error = ((await res.json()) as { error: { details: Record<string, unknown> } }).error;
    expect(error.details.reason).toBe("token_verification_failed");
    expect(queries).toHaveLength(0);
  });

  it("verifies, envelopes custody, records facts, activates — one request", async () => {
    const api = cloudflareApi();
    let custodyInsert: unknown[] = [];
    let factsInsert: unknown[] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("INSERT INTO integrations.connections")) {
        return [connectionRow({ id: params[0] as string })];
      }
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        custodyInsert = params;
        return [{
          id: "cred", connection_id: params[1], kind: params[2], ciphertext: params[3],
          external_ref: params[5], created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("INSERT INTO integrations.cloudflare_accounts")) {
        factsInsert = params;
        return [{
          id: "facts", connection_id: params[1], account_external_id: params[2],
          account_name: params[3], parent_token_ref: params[4], token_status: "active",
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("SET status = 'active'")) {
        return [connectionRow({
          id: factsInsert[1] as string ?? CONNECTION_UUID,
          status: "active",
          external_account_login: "Acme Infra",
          external_account_id: ACCOUNT_ID,
          external_account_type: "account",
          connected_at: NOW.toISOString(),
        })];
      }
      return [];
    });

    const res = await handleConnectIntegration(
      connectRequest({ parentToken: PARENT_TOKEN, displayName: "Infra" }),
      createEnv(), "req_1", ACTOR, ORG_ID, "cloudflare", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(201);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    const connection = data.connection as Record<string, unknown>;
    expect(connection.status).toBe("active");
    expect(connection.provider).toBe("cloudflare");
    // Token-kind connect returns no installUrl — nothing to pop up.
    expect(data.installUrl).toBeUndefined();

    // Custody: the envelope decrypts back to the paste; the raw value is
    // never stored, and the account id anchors future mints.
    expect(custodyInsert[2]).toBe("cloudflare_parent_token");
    expect(custodyInsert[5]).toBe(ACCOUNT_ID);
    const ciphertext = custodyInsert[3] as string;
    expect(ciphertext).not.toContain(PARENT_TOKEN);
    const adapter = (await createEncryptionAdapter(KEY))!;
    expect(await adapter.decrypt(JSON.parse(ciphertext))).toBe(PARENT_TOKEN);

    // Verified facts.
    expect(factsInsert[2]).toBe(ACCOUNT_ID);
    expect(factsInsert[4]).toBe("parent-token-id");
  });
});

// ── Re-auth (IH9): a paste for an already-bound account ─────

describe("cloudflare token re-auth (IH9)", () => {
  const EXISTING_UUID = "44444444-4444-4444-8444-444444444444";

  function connectRequest(body: Record<string, unknown>): Request {
    return new Request("https://worker.test/v1/organizations/x/integrations/cloudflare/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function existingConnection(status: string): Record<string, unknown> {
    return {
      id: EXISTING_UUID,
      org_id: ORG_UUID,
      provider: "cloudflare",
      status,
      scope: "account",
      share_mode: "auto",
      display_name: "Infra",
      created_by: "usr_abc",
      external_account_login: "Acme Infra",
      external_account_id: ACCOUNT_ID,
      external_account_type: "account",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
  }

  function boundFactsRow(): Record<string, unknown> {
    return {
      id: "facts",
      connection_id: EXISTING_UUID,
      account_external_id: ACCOUNT_ID,
      account_name: "Acme Infra",
      parent_token_ref: "old-parent-id",
      granted_policies: null,
      token_status: "invalid",
      parent_expires_at: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
  }

  it("re-authorizes a suspended connection: fresh custody, facts refresh, reactivate — no new connection", async () => {
    const api = cloudflareApi();
    let custodyInsert: unknown[] = [];
    let factsUpsert: unknown[] = [];
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.cloudflare_accounts WHERE account_external_id")) {
        return [boundFactsRow()];
      }
      if (text.includes("FROM integrations.connections WHERE org_id")) {
        return [existingConnection("suspended")];
      }
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        custodyInsert = params;
        return [{
          id: "cred", connection_id: params[1], kind: params[2], ciphertext: params[3],
          external_ref: params[5], created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("INSERT INTO integrations.cloudflare_accounts")) {
        factsUpsert = params;
        return [{ ...boundFactsRow(), token_status: "active", parent_token_ref: params[4] }];
      }
      if (text.includes("SET status = $3")) {
        return [existingConnection("active")];
      }
      return [];
    });

    const res = await handleConnectIntegration(
      connectRequest({ parentToken: PARENT_TOKEN }),
      createEnv(), "req_1", ACTOR, ORG_ID, "cloudflare", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect((data.connection as Record<string, unknown>).status).toBe("active");

    // Custody landed on the EXISTING connection; no placeholder was created.
    expect(custodyInsert[1]).toBe(EXISTING_UUID);
    expect(factsUpsert[1]).toBe(EXISTING_UUID);
    expect(factsUpsert[4]).toBe("parent-token-id"); // refreshed parent ref
    expect(queries.some((q) => q.text.includes("INSERT INTO integrations.connections"))).toBe(false);
    // REACTIVATED event, never the token.
    const events = queries.filter((q) => q.text.includes("WITH inserted_event"));
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events[0]!.params)).toContain("integration.reactivated");
    for (const q of events) {
      expect(JSON.stringify(q.params)).not.toContain(PARENT_TOKEN);
    }
  });

  it("re-auth of an ACTIVE connection refreshes custody without a status write", async () => {
    const api = cloudflareApi();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.cloudflare_accounts WHERE account_external_id")) {
        return [boundFactsRow()];
      }
      if (text.includes("FROM integrations.connections WHERE org_id")) {
        return [existingConnection("active")];
      }
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        return [{ id: "cred", created_at: NOW.toISOString(), updated_at: NOW.toISOString() }];
      }
      if (text.includes("INSERT INTO integrations.cloudflare_accounts")) {
        return [{ ...boundFactsRow(), token_status: "active" }];
      }
      return [];
    });
    const res = await handleConnectIntegration(
      connectRequest({ parentToken: PARENT_TOKEN }),
      createEnv(), "req_1", ACTOR, ORG_ID, "cloudflare", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(queries.some((q) => q.text.includes("SET status = $3"))).toBe(false);
  });

  it("refuses to flip an account bound to a connection this org cannot see", async () => {
    const api = cloudflareApi();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.cloudflare_accounts WHERE account_external_id")) {
        return [boundFactsRow()];
      }
      // getConnection finds nothing — bound elsewhere.
      return [];
    });
    const res = await handleConnectIntegration(
      connectRequest({ parentToken: PARENT_TOKEN }),
      createEnv(), "req_1", ACTOR, ORG_ID, "cloudflare", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(409);
    // The binding never flipped and nothing was written.
    expect(queries.some((q) => q.text.includes("INSERT INTO"))).toBe(false);
  });

  it("falls through to a fresh connect when the own bound connection is revoked", async () => {
    const api = cloudflareApi();
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.cloudflare_accounts WHERE account_external_id")) {
        return [boundFactsRow()];
      }
      if (text.includes("FROM integrations.connections WHERE org_id")) {
        return [existingConnection("revoked")];
      }
      if (text.includes("INSERT INTO integrations.connections")) {
        return [{
          id: params[0], org_id: ORG_UUID, provider: "cloudflare", status: "pending",
          scope: "account", share_mode: "auto", created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        return [{ id: "cred", created_at: NOW.toISOString(), updated_at: NOW.toISOString() }];
      }
      if (text.includes("INSERT INTO integrations.cloudflare_accounts")) {
        // Flip-style upsert rebinds the account to the fresh connection.
        return [{ ...boundFactsRow(), connection_id: params[1] }];
      }
      if (text.includes("SET status = 'active'")) {
        return [{
          id: CONNECTION_UUID, org_id: ORG_UUID, provider: "cloudflare", status: "active",
          scope: "account", share_mode: "auto", external_account_id: ACCOUNT_ID,
          external_account_type: "account", connected_at: NOW.toISOString(),
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      return [];
    });
    const res = await handleConnectIntegration(
      connectRequest({ parentToken: PARENT_TOKEN }),
      createEnv(), "req_1", ACTOR, ORG_ID, "cloudflare", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(201);
    expect(queries.some((q) => q.text.includes("INSERT INTO integrations.connections"))).toBe(true);
  });
});

// ── Mint through the IH4 core with real custody ─────────────

describe("mint via broker core (cloudflare)", () => {
  it("decrypts custody, passes the parent + mintRef, ledgers the mint", async () => {
    const api = cloudflareApi();
    const adapter = (await createEncryptionAdapter(KEY))!;
    const envelope = await adapter.encrypt(PARENT_TOKEN);
    let ledgerInsert: unknown[] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.connections")) {
        return [{
          id: CONNECTION_UUID, org_id: ORG_UUID, provider: "cloudflare", status: "active",
          scope: "account", share_mode: "auto", created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("FROM integrations.provider_credentials")) {
        return [{
          id: "cred", connection_id: CONNECTION_UUID, kind: "cloudflare_parent_token",
          ciphertext: JSON.stringify(envelope), external_ref: ACCOUNT_ID,
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("INSERT INTO integrations.minted_credentials")) {
        ledgerInsert = params;
        return [{
          id: params[0], org_id: ORG_UUID, connection_id: CONNECTION_UUID, provider: "cloudflare",
          template: "workers-deploy", purpose: "api", ttl_seconds: params[10],
          provider_ref: params[11], minted_at: NOW.toISOString(),
          expires_at: new Date(NOW.getTime() + 900_000).toISOString(), revoke_status: "pending",
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      return [];
    });

    const res = await handleMintCredential(
      new Request("https://worker.test/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template: "workers-deploy" }),
      }),
      createEnv(), "req_1", ACTOR, ORG_ID, asUuid(CONNECTION_UUID),
      { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(201);
    const data = ((await res.json()) as { data: { credential: Record<string, string> } }).data;
    expect(data.credential.token).toBe("cf-child-SECRET");

    // The provider-side name carries the ledger identity (IH9 reconcile).
    const create = api.calls.find((c) => c.method === "POST" && c.url.includes("/tokens"));
    const name = String(create!.body!.name);
    expect(name).toMatch(/^orun\/org_[0-9a-f]{32}\/workers-deploy\/mint_[0-9a-f]{32}$/);
    expect(name).toContain(`mint_${String(ledgerInsert[0]).replace(/-/g, "")}`);
    expect(ledgerInsert[11]).toBe("child-token-id"); // provider_ref
  });
});
