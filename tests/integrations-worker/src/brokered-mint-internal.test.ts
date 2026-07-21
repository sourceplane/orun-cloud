// IH7: the internal brokered-secret surface (design §5.4) — the two
// service-binding-only routes config-worker drives. Rules under test: the
// validate-binding read (typed reasons, no ledger spend), the internal mint
// (purpose secret_resolve + run attribution in the ledger, single-opaque-value
// reveal, orphan handling on unusable shapes), and that the broker's OWN gates
// (entitlement, rate limit, custody, ledger-before-reveal) hold on this
// surface exactly as on the public one.

import {
  handleInternalMintCredential,
  handleValidateBrokerBinding,
} from "@integrations-worker/handlers/credential-broker";
import { route } from "@integrations-worker/router";
import type { Env } from "@integrations-worker/env";
import type { IntegrationProvider } from "@integrations-worker/providers/types";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const MINT_UUID = "55555555-5555-4555-8555-555555555555";
const CONNECTION_PUBLIC = `int_${CONNECTION_UUID.replace(/-/g, "")}`;
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
    MEMBERSHIP_WORKER: jsonFetcher({ data: { memberships: [] } }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "internal" } }),
    BILLING_WORKER: billingFetcher(),
    SECRET_ENCRYPTION_KEY: "ab".repeat(32),
    ...overrides,
  } as unknown as Env;
}

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
    purpose: "secret_resolve",
    requested_by: "usr_runner",
    run_id: "run_1",
    job_id: "job_1",
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

function fakeBrokerProvider(opts?: {
  mintFails?: "not_implemented" | "parent_grant_insufficient" | "provider_error";
  credential?: Record<string, string>;
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
            credential: opts?.credential ?? { token: "cf-child-token-SECRET" },
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

function post(body: Record<string, unknown>): Request {
  return new Request("https://worker.test/internal/credentials/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function bindingBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    orgId: ORG_UUID,
    connectionId: CONNECTION_PUBLIC,
    template: "workers-deploy",
    ...overrides,
  };
}

async function errorDetails(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { error: { details: Record<string, unknown> } }).error.details;
}

describe("router gating for the internal broker routes", () => {
  function routed(path: string, headers?: Record<string, string>, method = "POST"): Request {
    return new Request(`https://worker.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: method === "POST" ? JSON.stringify({}) : null,
    });
  }

  it.each(["/internal/credentials/mint", "/internal/credentials/validate-binding"])(
    "403s %s without an allowed internal caller",
    async (path) => {
      expect((await route(routed(path), createEnv())).status).toBe(403);
      expect(
        (await route(routed(path, { "x-internal-caller": "api-edge" }), createEnv())).status,
      ).toBe(403);
    },
  );

  it.each(["/internal/credentials/mint", "/internal/credentials/validate-binding"])(
    "405s a non-POST on %s",
    async (path) => {
      const res = await route(routed(path, { "x-internal-caller": "config-worker" }, "GET"), createEnv());
      expect(res.status).toBe(405);
    },
  );

  it("admits config-worker through the binding boundary", async () => {
    // No PLATFORM_DB → the route is reached and answers 503, proving the
    // caller cleared the gate (mirrors the writeback-internal convention).
    const res = await route(
      routed("/internal/credentials/validate-binding", { "x-internal-caller": "config-worker" }),
      createEnv({ PLATFORM_DB: undefined }),
    );
    expect(res.status).toBe(503);
  });
});

describe("POST /internal/credentials/validate-binding", () => {
  it("validates a bindable pointer and returns the provider for provenance", async () => {
    const { provider } = fakeBrokerProvider();
    const { executor, queries } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections") ? [connectionRow()] : [],
    );
    const res = await handleValidateBrokerBinding(
      post(bindingBody({ params: { accountId: "acc1" } })),
      createEnv(), "req_1", { executor, provider },
    );
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(data.provider).toBe("cloudflare");
    expect(data.maxTtlSeconds).toBe(900);
    // Read-only: nothing ledgered, nothing minted.
    expect(queries.some((q) => q.text.includes("minted_credentials"))).toBe(false);
  });

  it("422s a malformed body with params_invalid", async () => {
    const { executor } = fakeExecutor(() => []);
    for (const bad of [
      bindingBody({ orgId: "org_11111111111111111111111111111111" }), // public form, not raw uuid
      bindingBody({ connectionId: "not-a-connection" }),
      bindingBody({ template: "Not A Template!" }),
    ]) {
      const res = await handleValidateBrokerBinding(post(bad), createEnv(), "req_1", { executor });
      expect(res.status).toBe(422);
      expect((await errorDetails(res)).reason).toBe("params_invalid");
    }
  });

  it("404s an unknown connection with connection_not_found", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleValidateBrokerBinding(post(bindingBody()), createEnv(), "req_1", { executor });
    expect(res.status).toBe(404);
    expect((await errorDetails(res)).reason).toBe("connection_not_found");
  });

  it("412s an inactive connection with connection_inactive", async () => {
    const { provider } = fakeBrokerProvider();
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections") ? [connectionRow({ status: "suspended" })] : [],
    );
    const res = await handleValidateBrokerBinding(post(bindingBody()), createEnv(), "req_1", { executor, provider });
    expect(res.status).toBe(412);
    expect((await errorDetails(res)).reason).toBe("connection_inactive");
  });

  it("400s a provider without a broker capability", async () => {
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections") ? [connectionRow({ provider: "github" })] : [],
    );
    const env = createEnv({
      GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "s", GITHUB_APP_PRIVATE_KEY: "p", GITHUB_APP_WEBHOOK_SECRET: "w",
    });
    const res = await handleValidateBrokerBinding(post(bindingBody({ template: "repo-token" })), env, "req_1", { executor });
    expect(res.status).toBe(400);
    expect((await errorDetails(res)).reason).toBe("capability_not_supported");
  });

  it("422s an unknown template and unknown params with typed reasons", async () => {
    const { provider } = fakeBrokerProvider();
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections") ? [connectionRow()] : [],
    );
    const unknownTemplate = await handleValidateBrokerBinding(
      post(bindingBody({ template: "nope" })), createEnv(), "req_1", { executor, provider },
    );
    expect(unknownTemplate.status).toBe(422);
    expect((await errorDetails(unknownTemplate)).reason).toBe("template_unknown");

    const unknownParams = await handleValidateBrokerBinding(
      post(bindingBody({ params: { zoneId: "z" } })), createEnv(), "req_1", { executor, provider },
    );
    expect(unknownParams.status).toBe(422);
    expect((await errorDetails(unknownParams)).reason).toBe("params_invalid");
  });
});

describe("POST /internal/credentials/mint", () => {
  function mintBody(overrides?: Record<string, unknown>): Record<string, unknown> {
    return bindingBody({
      purpose: "secret_resolve",
      requestedBy: "usr_runner",
      requestedByType: "workflow",
      runId: "run_1",
      jobId: "job_1",
      params: { accountId: "acc1" },
      ...overrides,
    });
  }

  it("mints with purpose secret_resolve and the run attribution in the ledger", async () => {
    const { provider } = fakeBrokerProvider();
    let ledgerInsert: unknown[] = [];
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [CUSTODY_ROW];
      if (text.includes("INSERT INTO integrations.minted_credentials")) {
        ledgerInsert = params;
        return [mintRow()];
      }
      return [];
    });
    const res = await handleInternalMintCredential(post(mintBody()), createEnv(), "req_1", { executor, provider });
    expect(res.status).toBe(201);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    // The injectable value — a SINGLE opaque string, reveal-once.
    expect(data.value).toBe("cf-child-token-SECRET");
    expect((data.mint as Record<string, unknown>).purpose).toBe("secret_resolve");
    // Ledger columns: (id, org, connection, provider, template, params,
    // purpose, parent_kind, requested_by, run_id, job_id, ttl, provider_ref,
    // expires_at).
    expect(ledgerInsert[6]).toBe("secret_resolve");
    expect(ledgerInsert[7]).toBe("cloudflare_parent_token");
    expect(ledgerInsert[8]).toBe("usr_runner");
    expect(ledgerInsert[9]).toBe("run_1");
    expect(ledgerInsert[10]).toBe("job_1");
    // Events never carry the value.
    for (const q of queries.filter((q) => q.text.includes("WITH inserted_event"))) {
      expect(JSON.stringify(q.params)).not.toContain("cf-child-token-SECRET");
    }
  });

  it("mints with purpose rotation and ledgers it without run attribution (RS1)", async () => {
    const { provider } = fakeBrokerProvider();
    let ledgerInsert: unknown[] = [];
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [CUSTODY_ROW];
      if (text.includes("INSERT INTO integrations.minted_credentials")) {
        ledgerInsert = params;
        return [mintRow({ purpose: "rotation", run_id: null, job_id: null, requested_by: "usr_admin" })];
      }
      return [];
    });
    const res = await handleInternalMintCredential(
      post(mintBody({ purpose: "rotation", requestedBy: "usr_admin", requestedByType: "user", runId: undefined, jobId: undefined })),
      createEnv(),
      "req_1",
      { executor, provider },
    );
    expect(res.status).toBe(201);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(data.value).toBe("cf-child-token-SECRET");
    expect((data.mint as Record<string, unknown>).purpose).toBe("rotation");
    // Ledger purpose column carries the rotation discriminator; no run/job.
    expect(ledgerInsert[6]).toBe("rotation");
    expect(ledgerInsert[8]).toBe("usr_admin");
    expect(ledgerInsert[9]).toBeNull();
    expect(ledgerInsert[10]).toBeNull();
    // Events never carry the value.
    for (const q of queries.filter((q) => q.text.includes("WITH inserted_event"))) {
      expect(JSON.stringify(q.params)).not.toContain("cf-child-token-SECRET");
    }
  });

  it("422s a non-internal purpose (api never reaches this route)", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleInternalMintCredential(
      post(mintBody({ purpose: "api" })), createEnv(), "req_1", { executor },
    );
    expect(res.status).toBe(422);
    expect((await errorDetails(res)).reason).toBe("params_invalid");
  });

  it("still enforces the broker entitlement on the internal surface", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleInternalMintCredential(
      post(mintBody()),
      createEnv({ BILLING_WORKER: billingFetcher({ brokerAllowed: false }) }),
      "req_1", { executor },
    );
    expect(res.status).toBe(412);
    expect((await errorDetails(res)).entitlementKey).toBe("feature.integrations.credential_broker");
  });

  it("still enforces the per-org daily rate limit against the ledger", async () => {
    const { provider } = fakeBrokerProvider();
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("COUNT(*)")) return [{ count: 25 }];
      return [];
    });
    const res = await handleInternalMintCredential(
      post(mintBody()),
      createEnv({ BILLING_WORKER: billingFetcher({ mintsPerDay: 25 }) }),
      "req_1", { executor, provider },
    );
    expect(res.status).toBe(412);
    expect((await errorDetails(res)).reason).toBe("limit_reached");
  });

  it("fails closed on a revoked/suspended connection with connection_inactive", async () => {
    const { provider } = fakeBrokerProvider();
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections") ? [connectionRow({ status: "revoked" })] : [],
    );
    const res = await handleInternalMintCredential(post(mintBody()), createEnv(), "req_1", { executor, provider });
    expect(res.status).toBe(412);
    expect((await errorDetails(res)).reason).toBe("connection_inactive");
  });

  it("412s with parent_credential_missing when custody cannot supply the parent", async () => {
    const { provider } = fakeBrokerProvider();
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections") ? [connectionRow()] : [],
    );
    const res = await handleInternalMintCredential(post(mintBody()), createEnv(), "req_1", { executor, provider });
    expect(res.status).toBe(412);
    expect((await errorDetails(res)).reason).toBe("parent_credential_missing");
  });

  it("502s a provider refusal with provider_error", async () => {
    const { provider } = fakeBrokerProvider({ mintFails: "provider_error" });
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [CUSTODY_ROW];
      return [];
    });
    const res = await handleInternalMintCredential(post(mintBody()), createEnv(), "req_1", { executor, provider });
    expect(res.status).toBe(502);
    expect((await errorDetails(res)).reason).toBe("provider_error");
  });

  it("refuses to reveal when the ledger insert fails — and revokes the orphan", async () => {
    const { provider, revokes } = fakeBrokerProvider();
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [CUSTODY_ROW];
      if (text.includes("INSERT INTO integrations.minted_credentials")) return [];
      return [];
    });
    const res = await handleInternalMintCredential(post(mintBody()), createEnv(), "req_1", { executor, provider });
    expect(res.status).toBe(503);
    expect(revokes).toEqual(["cf-token-1"]);
  });

  it("refuses (and orphans) a credential that is not a single opaque value", async () => {
    const { provider, revokes } = fakeBrokerProvider({
      credential: { token: "one-SECRET", extra: "two-SECRET" },
    });
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [CUSTODY_ROW];
      if (text.includes("INSERT INTO integrations.minted_credentials")) return [mintRow()];
      if (text.includes("UPDATE integrations.minted_credentials")) {
        return [mintRow({ revoke_status: "orphaned" })];
      }
      return [];
    });
    const res = await handleInternalMintCredential(post(mintBody()), createEnv(), "req_1", { executor, provider });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { details: Record<string, unknown> } };
    expect(body.error.details.reason).toBe("provider_error");
    // Provider-side revoke + ledger marked orphaned; the values never leave.
    expect(revokes).toEqual(["cf-token-1"]);
    expect(
      queries.some(
        (q) => q.text.includes("UPDATE integrations.minted_credentials") && JSON.stringify(q.params).includes("orphaned"),
      ),
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });
});
