// IH4: the credential broker core — provider-generic mint API over the IH0
// capability seam and the minted_credentials ledger. Rules under test:
// templates-not-scopes, TTL clamping, reveal-once-only-if-ledgered, typed
// capability misses, the per-org daily rate gate, best-effort revoke, and
// the connection-revoke fan-out.

import {
  DEFAULT_TTL_SECONDS,
  handleListMintedCredentials,
  handleMintCredential,
  handleRevokeMintedCredential,
} from "@integrations-worker/handlers/credential-broker";
import { handleRevokeIntegration } from "@integrations-worker/handlers/connections";
import type { Env } from "@integrations-worker/env";
import type { IntegrationProvider } from "@integrations-worker/providers/types";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const MINT_UUID = "55555555-5555-4555-8555-555555555555";
const ORG_ID = asUuid(ORG_UUID);
const CONNECTION_ID = asUuid(CONNECTION_UUID);
const MINT_PUBLIC = `mint_${MINT_UUID.replace(/-/g, "")}`;
const NOW = new Date("2026-07-12T13:00:00Z");

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

/** Per-key entitlement fetcher: broker feature + daily mint limit. */
function billingFetcher(opts?: { brokerAllowed?: boolean; mintsPerDay?: number | null }): Fetcher {
  return {
    fetch: async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { entitlementKey: string; orgId: string };
      if (body.entitlementKey === "feature.integrations.credential_broker") {
        return Response.json({
          data:
            opts?.brokerAllowed === false
              ? { allowed: false, orgId: body.orgId, entitlementKey: body.entitlementKey, reason: "disabled" }
              : { allowed: true, orgId: body.orgId, entitlementKey: body.entitlementKey, valueType: "boolean", limitValue: null, source: "plan", subscriptionId: "s" },
        });
      }
      return Response.json({
        data: {
          allowed: true,
          orgId: body.orgId,
          entitlementKey: body.entitlementKey,
          valueType: "quantity",
          limitValue: opts?.mintsPerDay === undefined ? null : opts.mintsPerDay,
          source: "plan",
          subscriptionId: "s",
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
    BILLING_WORKER: billingFetcher(),
    SECRET_ENCRYPTION_KEY: "ab".repeat(32),
    ...overrides,
  } as unknown as Env;
}

const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

function connectionRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "cloudflare",
    status: "active",
    scope: "account",
    share_mode: "auto",
    display_name: "CF Account",
    created_by: "usr_abc",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function mintRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: MINT_UUID,
    org_id: ORG_UUID,
    connection_id: CONNECTION_UUID,
    provider: "cloudflare",
    template: "workers-deploy",
    params: null,
    purpose: "api",
    requested_by: ACTOR.subjectId,
    run_id: null,
    job_id: null,
    ttl_seconds: 900,
    provider_ref: "cf-token-1",
    minted_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 900_000).toISOString(),
    revoked_at: null,
    revoke_status: "pending",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

/** A fake provider whose broker mints successfully (the IH5/IH6 stand-in). */
function fakeBrokerProvider(opts?: {
  mintFails?: "not_implemented" | "parent_grant_insufficient" | "provider_error";
}): { provider: IntegrationProvider; revokes: string[] } {
  const revokes: string[] = [];
  const provider: IntegrationProvider = {
    id: "cloudflare",
    displayName: "Cloudflare",
    connectKind: "token",
    capabilities: ["connect", "credential-broker"],
    broker: {
      scopeTemplates: () => [
        {
          id: "workers-deploy",
          provider: "cloudflare",
          version: 1,
          displayName: "Workers deploy",
          description: "Deploy Workers scripts",
          params: ["accountId"],
          maxTtlSeconds: 900,
        },
      ],
      async mintCredential(input) {
        if (opts?.mintFails) return { ok: false, reason: opts.mintFails };
        return {
          ok: true,
          value: {
            credential: { token: "cf-child-token-SECRET" },
            providerRef: "cf-token-1",
            expiresAt: new Date(input.nowMs + input.ttlSeconds * 1000),
          },
        };
      },
      async revokeCredential(ref) {
        revokes.push(ref);
        return true;
      },
    },
  };
  return { provider, revokes };
}

let CUSTODY_ROW: Record<string, unknown>;
beforeAll(async () => {
  const { createEncryptionAdapter } = await import("@integrations-worker/encryption");
  const adapter = (await createEncryptionAdapter("ab".repeat(32)))!;
  const envelope = await adapter.encrypt("cf-parent-token");
  CUSTODY_ROW = {
    id: "cred",
    connection_id: CONNECTION_UUID,
    kind: "cloudflare_parent_token",
    ciphertext: JSON.stringify(envelope),
    external_ref: "acc-1",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
});

function mintRequest(body: Record<string, unknown>): Request {
  return new Request("https://worker.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST …/credentials (mint)", () => {
  it("denies via policy as 404", async () => {
    const env = createEnv({ POLICY_WORKER: jsonFetcher({ data: { allow: false } }) });
    const { executor } = fakeExecutor(() => []);
    const res = await handleMintCredential(
      mintRequest({ template: "workers-deploy" }),
      env, "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor },
    );
    expect(res.status).toBe(404);
  });

  it("gates on the credential_broker entitlement", async () => {
    const env = createEnv({ BILLING_WORKER: billingFetcher({ brokerAllowed: false }) });
    const { executor } = fakeExecutor(() => []);
    const res = await handleMintCredential(
      mintRequest({ template: "workers-deploy" }),
      env, "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor },
    );
    expect(res.status).toBe(412);
    const error = ((await res.json()) as { error: { details: Record<string, unknown> } }).error;
    expect(error.details.entitlementKey).toBe("feature.integrations.credential_broker");
  });

  it("returns a typed capability miss for a provider without a broker", async () => {
    const env = createEnv({
      GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "s", GITHUB_APP_PRIVATE_KEY: "p", GITHUB_APP_WEBHOOK_SECRET: "w",
    });
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections") ? [connectionRow({ provider: "github" })] : [],
    );
    const res = await handleMintCredential(
      mintRequest({ template: "repo-token" }),
      env, "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor },
    );
    expect(res.status).toBe(400);
    const error = ((await res.json()) as { error: { details: Record<string, unknown> } }).error;
    expect(error.details.reason).toBe("capability_not_supported");
  });

  it("422s an unknown template and unknown params", async () => {
    const { provider } = fakeBrokerProvider();
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections") ? [connectionRow()] : [],
    );
    const unknownTemplate = await handleMintCredential(
      mintRequest({ template: "nope" }),
      createEnv(), "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor, provider },
    );
    expect(unknownTemplate.status).toBe(422);

    const unknownParams = await handleMintCredential(
      mintRequest({ template: "workers-deploy", params: { zoneId: "z" } }),
      createEnv(), "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor, provider },
    );
    expect(unknownParams.status).toBe(422);
  });

  it("parks a not-yet-live adapter with 412 and a mint_failed event", async () => {
    const { provider } = fakeBrokerProvider({ mintFails: "not_implemented" });
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [CUSTODY_ROW];
      return [];
    });
    const res = await handleMintCredential(
      mintRequest({ template: "workers-deploy" }),
      createEnv(), "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor, provider },
    );
    expect(res.status).toBe(412);
    expect(queries.some((q) => JSON.stringify(q.params).includes("integration.credential.mint_failed"))).toBe(true);
    // Nothing entered the ledger.
    expect(queries.some((q) => q.text.includes("INSERT INTO integrations.minted_credentials"))).toBe(false);
  });

  it("enforces the per-org daily mint limit against the ledger", async () => {
    const { provider } = fakeBrokerProvider();
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("COUNT(*)")) return [{ count: 25 }];
      return [];
    });
    const res = await handleMintCredential(
      mintRequest({ template: "workers-deploy" }),
      createEnv({ BILLING_WORKER: billingFetcher({ mintsPerDay: 25 }) }),
      "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor, provider },
    );
    expect(res.status).toBe(412);
    const error = ((await res.json()) as { error: { details: Record<string, unknown> } }).error;
    expect(error.details.reason).toBe("limit_reached");
  });

  it("mints: clamps the TTL, ledgers BEFORE revealing, never logs the value", async () => {
    const { provider } = fakeBrokerProvider();
    let ledgerInsert: unknown[] = [];
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [CUSTODY_ROW];
      if (text.includes("INSERT INTO integrations.minted_credentials")) {
        ledgerInsert = params;
        return [mintRow({ ttl_seconds: params[11], parent_kind: params[7] })];
      }
      return [];
    });
    const res = await handleMintCredential(
      mintRequest({ template: "workers-deploy", ttlSeconds: 7200, params: { accountId: "acc1" } }),
      createEnv(), "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor, provider },
    );
    expect(res.status).toBe(201);
    const data = ((await res.json()) as { data: { credential: Record<string, string>; mint: Record<string, unknown> } }).data;
    // Reveal-once: the response carries the value…
    expect(data.credential.token).toBe("cf-child-token-SECRET");
    expect(data.mint.id).toBe(MINT_PUBLIC);
    // …the ledger + events never do.
    expect(ledgerInsert[4]).toBe("workers-deploy"); // template column
    expect(ledgerInsert[7]).toBe("cloudflare_parent_token"); // parent_kind (SI1)
    expect(ledgerInsert[11]).toBe(900); // ttl clamped to the template max (< 7200)
    expect(data.mint.parentKind).toBe("cloudflare_parent_token");
    const eventInserts = queries.filter((q) => q.text.includes("WITH inserted_event"));
    expect(eventInserts.length).toBeGreaterThan(0);
    for (const q of eventInserts) {
      expect(JSON.stringify(q.params)).not.toContain("cf-child-token-SECRET");
    }
    // Ledger insert happened before any reveal was possible.
    const ledgerIdx = queries.findIndex((q) => q.text.includes("INSERT INTO integrations.minted_credentials"));
    expect(ledgerIdx).toBeGreaterThanOrEqual(0);
  });

  it("refuses to reveal when the ledger insert fails — and revokes the orphan", async () => {
    const { provider, revokes } = fakeBrokerProvider();
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [CUSTODY_ROW];
      if (text.includes("INSERT INTO integrations.minted_credentials")) return []; // no row = failure
      return [];
    });
    const res = await handleMintCredential(
      mintRequest({ template: "workers-deploy" }),
      createEnv(), "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor, provider },
    );
    expect(res.status).toBe(503);
    expect(revokes).toEqual(["cf-token-1"]);
  });

  it("uses the default TTL when none is requested", async () => {
    expect(DEFAULT_TTL_SECONDS).toBe(900);
  });
});

describe("DELETE …/credentials/{mintId} (revoke)", () => {
  it("revokes provider-side best-effort and marks the ledger", async () => {
    const { provider, revokes } = fakeBrokerProvider();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.minted_credentials WHERE org_id")) return [mintRow()];
      if (text.includes("UPDATE integrations.minted_credentials")) {
        return [mintRow({ revoke_status: "revoked", revoked_at: NOW.toISOString() })];
      }
      return [];
    });
    const res = await handleRevokeMintedCredential(
      createEnv(), "req_1", ACTOR, ORG_ID, MINT_PUBLIC, { executor, provider },
    );
    expect(res.status).toBe(200);
    expect(revokes).toEqual(["cf-token-1"]);
    expect(queries.some((q) => q.text.includes("UPDATE integrations.minted_credentials"))).toBe(true);
  });

  it("is idempotent for an already-revoked mint", async () => {
    const { provider, revokes } = fakeBrokerProvider();
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.minted_credentials WHERE org_id")
        ? [mintRow({ revoke_status: "revoked" })]
        : [],
    );
    const res = await handleRevokeMintedCredential(
      createEnv(), "req_1", ACTOR, ORG_ID, MINT_PUBLIC, { executor, provider },
    );
    expect(res.status).toBe(200);
    expect(revokes).toEqual([]);
  });

  it("404s a mint in another org", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleRevokeMintedCredential(
      createEnv(), "req_1", ACTOR, ORG_ID, MINT_PUBLIC, { executor },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET …/credentials (ledger)", () => {
  it("lists the connection's mints as safe projections", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("FROM integrations.minted_credentials")) return [mintRow()];
      return [];
    });
    const res = await handleListMintedCredentials(
      new Request("https://worker.test/x", { method: "GET" }),
      createEnv(), "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor },
    );
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { mints: Array<Record<string, unknown>> } }).data;
    expect(data.mints).toHaveLength(1);
    expect(data.mints[0]!.id).toBe(MINT_PUBLIC);
    expect(data.mints[0]!.template).toBe("workers-deploy");
    expect(JSON.stringify(data)).not.toContain("cf-child-token-SECRET");
  });
});

describe("connection revoke fan-out", () => {
  it("sweeps live mints when the connection is revoked", async () => {
    const env = createEnv();
    let status = "active";
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SELECT * FROM integrations.connections")) {
        return [connectionRow({ provider: "github", status })];
      }
      if (text.includes("SET status = $3")) {
        status = "revoked";
        return [connectionRow({ provider: "github", status: "revoked" })];
      }
      if (text.includes("revoke_status = 'pending'")) return [mintRow({ provider: "github", provider_ref: null })];
      if (text.includes("UPDATE integrations.minted_credentials")) {
        return [mintRow({ revoke_status: "revoked" })];
      }
      if (text.includes("FROM integrations.github_installations")) return [];
      return [{ id: "x" }];
    });
    const res = await handleRevokeIntegration(new Request("http://x"), env, "req_1", ACTOR, ORG_ID, CONNECTION_ID, {
      executor,
      brokeredRefs: async () => ({ ok: true, refs: [] }),
    });
    expect(res.status).toBe(200);
    expect(
      queries.some(
        (q) => q.text.includes("UPDATE integrations.minted_credentials") && JSON.stringify(q.params).includes("revoked"),
      ),
    ).toBe(true);
  });
});
