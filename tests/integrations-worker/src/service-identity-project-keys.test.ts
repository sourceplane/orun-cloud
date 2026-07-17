// SI4 (sub-epics/service-identity-bootstrap): Supabase project credentials —
// the custody-served `project-service-key` template. Rules under test:
//   * fetchSupabaseProjectServiceKeys keeps only service_role keys,
//     best-effort per project, null when nothing could be read.
//   * A custody-served mint reads the org-owned enveloped key map — ZERO
//     management-API calls, no refresh spend, ledger parent_kind names the
//     infrastructure custody, reveal-once semantics unchanged.
//   * Typed failures: custody row missing → parent_credential_missing (412);
//     project entry missing → parent_grant_insufficient (412).
//   * The OAuth callback captures the key map as one encrypted JSON envelope
//     with project refs (never keys) as safe scope metadata.

import { handleMintCredential } from "@integrations-worker/handlers/credential-broker";
import { handleSupabaseOauthCallback } from "@integrations-worker/handlers/supabase-oauth";
import {
  createSupabaseProvider,
  fetchSupabaseProjectServiceKeys,
  SUPABASE_SCOPE_TEMPLATES,
} from "@integrations-worker/providers/supabase";
import { createEncryptionAdapter, type CiphertextEnvelope } from "@integrations-worker/encryption";
import { signConnectState, CONNECT_STATE_TTL_MS } from "@integrations-worker/state";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = asUuid(ORG_UUID);
const CONNECTION_ID = asUuid(CONNECTION_UUID);
const STATE_SECRET = "state-secret";
const KEY = "ef".repeat(32);
const REDIRECT_BASE = "https://api-edge.test";
const SUPABASE_ORG_ID = "sb-org-1";
const NOW = new Date("2026-07-17T16:00:00Z");
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

function billingFetcher(): Fetcher {
  return {
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
    INTEGRATIONS_STATE_SECRET: STATE_SECRET,
    SECRET_ENCRYPTION_KEY: KEY,
    OAUTH_REDIRECT_BASE_URL: REDIRECT_BASE,
    SUPABASE_OAUTH_CLIENT_ID: CREDS.clientId,
    SUPABASE_OAUTH_CLIENT_SECRET: CREDS.clientSecret,
    ...overrides,
  } as unknown as Env;
}

const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

/** Fake Supabase Management API with per-project api-keys. */
function supabaseApi(overrides?: { apiKeysFailFor?: string[] }): {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; method: string; auth: string | null }>;
} {
  const calls: Array<{ url: string; method: string; auth: string | null }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (input.includes("/v1/oauth/token")) {
      return Response.json({
        access_token: "sb-access-SECRET",
        refresh_token: "sb-refresh-OLD",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (input.includes("/api-keys")) {
      const ref = input.match(/\/v1\/projects\/([^/]+)\/api-keys/)?.[1] ?? "";
      if (overrides?.apiKeysFailFor?.includes(ref)) return new Response("nope", { status: 403 });
      return Response.json([
        { name: "anon", api_key: `anon-${ref}` },
        { name: "service_role", api_key: `service-${ref}-SECRET` },
      ]);
    }
    if (input.includes("/v1/organizations")) {
      return Response.json([{ id: SUPABASE_ORG_ID, name: "Acme Data" }]);
    }
    if (input.includes("/v1/projects")) {
      return Response.json([
        { ref: "proj-1", name: "app-db" },
        { ref: "proj-2", name: "analytics" },
      ]);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

describe("fetchSupabaseProjectServiceKeys (SI4)", () => {
  it("keeps only service_role keys, best-effort per project", async () => {
    const api = supabaseApi({ apiKeysFailFor: ["proj-2"] });
    const keys = await fetchSupabaseProjectServiceKeys("sb-access", ["proj-1", "proj-2"], api.fetchImpl);
    expect(keys).toEqual({ "proj-1": "service-proj-1-SECRET" });
  });

  it("returns null when no project's keys could be read (never overwrite custody with nothing)", async () => {
    const api = supabaseApi({ apiKeysFailFor: ["proj-1", "proj-2"] });
    const keys = await fetchSupabaseProjectServiceKeys("sb-access", ["proj-1", "proj-2"], api.fetchImpl);
    expect(keys).toBeNull();
  });
});

describe("custody-served project-service-key mint (SI4)", () => {
  const template = SUPABASE_SCOPE_TEMPLATES.find((t) => t.id === "project-service-key")!;

  it("declares the custody kind on the template", () => {
    expect(template.custodyKind).toBe("supabase_project_secret");
    expect(template.params).toEqual(["projectRef"]);
  });

  async function projectSecretRow(map: Record<string, string>): Promise<Record<string, unknown>> {
    const adapter = (await createEncryptionAdapter(KEY))!;
    return {
      id: "proj-secret-row",
      connection_id: CONNECTION_UUID,
      kind: "supabase_project_secret",
      credential_class: "infrastructure",
      ciphertext: JSON.stringify(await adapter.encrypt(JSON.stringify(map))),
      external_ref: SUPABASE_ORG_ID,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
  }

  function connectionRow(): Record<string, unknown> {
    return {
      id: CONNECTION_UUID,
      org_id: ORG_UUID,
      provider: "supabase",
      status: "active",
      scope: "account",
      share_mode: "auto",
      display_name: "Acme Data",
      created_by: "usr_abc",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
  }

  function mintRequest(body: Record<string, unknown>): Request {
    return new Request("https://worker.test/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("serves the key from custody: zero provider calls, ledger parent_kind = supabase_project_secret", async () => {
    const custody = await projectSecretRow({ "proj-1": "service-proj-1-SECRET" });
    const api = supabaseApi();
    const provider = createSupabaseProvider(CREDS, api.fetchImpl);
    let ledgerInsert: unknown[] = [];
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) {
        return params[1] === "supabase_project_secret" ? [custody] : [];
      }
      if (text.includes("INSERT INTO integrations.minted_credentials")) {
        ledgerInsert = params;
        return [{
          id: params[0], org_id: ORG_UUID, connection_id: CONNECTION_UUID, provider: "supabase",
          template: "project-service-key", params: params[5], purpose: "api", parent_kind: params[7],
          requested_by: ACTOR.subjectId, run_id: null, job_id: null, ttl_seconds: params[11],
          provider_ref: null, minted_at: NOW.toISOString(),
          expires_at: new Date(NOW.getTime() + 900_000).toISOString(),
          revoked_at: null, revoke_status: "pending",
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      return [];
    });

    const res = await handleMintCredential(
      mintRequest({ template: "project-service-key", params: { projectRef: "proj-1" } }),
      createEnv(), "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor, provider },
    );
    expect(res.status).toBe(201);
    const data = ((await res.json()) as { data: { credential: Record<string, string>; mint: Record<string, unknown> } }).data;
    expect(data.credential.value).toBe("service-proj-1-SECRET");
    expect(data.mint.parentKind).toBe("supabase_project_secret");

    // ZERO provider traffic: no refresh, no management call.
    expect(api.calls).toEqual([]);
    // Ledger: infrastructure parent kind, no provider ref, value never stored.
    expect(ledgerInsert[7]).toBe("supabase_project_secret");
    expect(ledgerInsert[12]).toBeNull();
    expect(JSON.stringify(queries.map((q) => q.params))).not.toContain("service-proj-1-SECRET");
  });

  it("412s parent_credential_missing when no key map is in custody", async () => {
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections") ? [connectionRow()] : [],
    );
    const provider = createSupabaseProvider(CREDS, supabaseApi().fetchImpl);
    const res = await handleMintCredential(
      mintRequest({ template: "project-service-key", params: { projectRef: "proj-1" } }),
      createEnv(), "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor, provider },
    );
    expect(res.status).toBe(412);
    const error = ((await res.json()) as { error: { details: Record<string, unknown> } }).error;
    expect(error.details.reason).toBe("parent_credential_missing");
  });

  it("412s parent_grant_insufficient when the project has no custodied entry", async () => {
    const custody = await projectSecretRow({ "proj-1": "service-proj-1-SECRET" });
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.connections")) return [connectionRow()];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) {
        return params[1] === "supabase_project_secret" ? [custody] : [];
      }
      return [];
    });
    const provider = createSupabaseProvider(CREDS, supabaseApi().fetchImpl);
    const res = await handleMintCredential(
      mintRequest({ template: "project-service-key", params: { projectRef: "proj-UNKNOWN" } }),
      createEnv(), "req_1", ACTOR, ORG_ID, CONNECTION_ID, { executor, provider },
    );
    expect(res.status).toBe(412);
    const error = ((await res.json()) as { error: { details: Record<string, unknown> } }).error;
    expect(error.details.reason).toBe("parent_grant_insufficient");
  });
});

describe("supabase OAuth callback captures project service keys (SI4)", () => {
  it("envelopes the key map with project refs as safe scope metadata", async () => {
    const adapter = (await createEncryptionAdapter(KEY))!;
    const verifierEnvelope = await adapter.encrypt("pkce-verifier-under-test-aaaaaaaaaaaaaaaaaaa");
    const verifierRow = {
      id: "pkce-row",
      connection_id: CONNECTION_UUID,
      kind: "supabase_pkce_verifier",
      ciphertext: JSON.stringify(verifierEnvelope),
      external_ref: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const pending = {
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
    };
    const custodyInserts: unknown[][] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pending];
      if (text.includes("SELECT * FROM integrations.provider_credentials")) {
        return params[1] === "supabase_pkce_verifier" ? [verifierRow] : [];
      }
      if (text.includes("SELECT * FROM integrations.supabase_orgs")) return [];
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        custodyInserts.push(params);
        return [{
          id: "cred-row", connection_id: CONNECTION_UUID, kind: params[2], credential_class: params[3],
          ciphertext: params[4], external_ref: params[6],
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("INSERT INTO integrations.supabase_orgs")) {
        return [{
          id: "sb-facts", connection_id: CONNECTION_UUID, supabase_org_id: SUPABASE_ORG_ID,
          org_name: "Acme Data", granted_scopes: null, projects: null,
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("SET status = 'active'")) {
        return [{ ...pending, status: "active", connected_at: NOW.toISOString() }];
      }
      return [];
    });

    const api = supabaseApi();
    const state = await signConnectState(
      { n: "e".repeat(32), p: "supabase", c: CONNECTION_UUID, o: ORG_UUID, exp: Date.now() + CONNECT_STATE_TTL_MS },
      STATE_SECRET,
    );
    const url = new URL("https://worker.test/ingress/supabase/oauth");
    url.searchParams.set("code", "c0de");
    url.searchParams.set("state", state);
    const res = await handleSupabaseOauthCallback(
      new Request(url.toString(), { method: "GET" }),
      createEnv(), "req_1", { executor, fetchImpl: api.fetchImpl },
    );
    expect(res.status).toBe(200);

    const projectSecret = custodyInserts.find((p) => p[2] === "supabase_project_secret");
    expect(projectSecret).toBeTruthy();
    expect(projectSecret![3]).toBe("infrastructure");
    expect(projectSecret![6]).toBe(SUPABASE_ORG_ID);
    // Safe metadata: refs only, never keys.
    expect(JSON.parse(String(projectSecret![5]))).toEqual(["proj-1", "proj-2"]);
    const decrypted = await adapter.decrypt(JSON.parse(projectSecret![4] as string) as CiphertextEnvelope);
    expect(JSON.parse(decrypted)).toEqual({
      "proj-1": "service-proj-1-SECRET",
      "proj-2": "service-proj-2-SECRET",
    });
  });
});
