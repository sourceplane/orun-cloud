// SC2: rotate the org-owned SOURCE credential behind a scoped credential.
//   cloudflare → roll the account-owned service token in place (same id).
//   a paste/legacy connection with no service token → rotation_unsupported.

import { rotateConnectionSource } from "@integrations-worker/handlers/rotate-source";
import { createEncryptionAdapter } from "@integrations-worker/encryption";
import type { Env } from "@integrations-worker/env";
import type { MintLockRunner } from "@integrations-worker/mint-lock";
import type { IntegrationConnection } from "@saas/db/integrations";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "9a7806061c88ada191ed06f989cc3dac";
const KEY = "cd".repeat(32);
const NOW = new Date("2026-07-18T12:00:00Z");

const ENV = { SECRET_ENCRYPTION_KEY: KEY } as unknown as Env;

/** Lock runner that just runs the section (no serialization needed here). */
const passthroughLock: MintLockRunner = async (_key, fn) => ({ ok: true, value: await fn() });

type QueryRecord = { text: string; params: unknown[] };

function fakeExecutor(
  respond: (text: string, params: unknown[]) => Record<string, unknown>[] | null,
): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      const p = params ?? [];
      queries.push({ text, params: p });
      const rows = respond(text, p);
      return { rows: (rows ?? []) as unknown as T[], rowCount: (rows ?? []).length };
    },
  };
  return { executor, queries };
}

function cfConnection(): IntegrationConnection {
  return {
    id: CONNECTION_UUID,
    orgId: ORG_UUID,
    provider: "cloudflare",
    status: "active",
    scope: "account",
    shareMode: "auto",
  } as unknown as IntegrationConnection;
}

async function serviceCustodyRow(): Promise<Record<string, unknown>> {
  const adapter = (await createEncryptionAdapter(KEY))!;
  return {
    id: "cred",
    connection_id: CONNECTION_UUID,
    kind: "cloudflare_service_token",
    credential_class: "infrastructure",
    ciphertext: JSON.stringify(await adapter.encrypt("cf-service-CURRENT")),
    external_ref: ACCOUNT_ID,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function cloudflareApi(rollFails = false): {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; method: string; auth: string | null }>;
} {
  const calls: Array<{ url: string; method: string; auth: string | null }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
    if (input.includes("/tokens/svc-token-id/value") && (init?.method ?? "GET") === "PUT") {
      return rollFails
        ? Response.json({ success: false, errors: [{ message: "no" }] }, { status: 400 })
        : Response.json({ success: true, result: "cf-service-ROLLED" });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

describe("rotateConnectionSource — cloudflare (SC2)", () => {
  it("rolls the service token in place and re-envelopes the new value", async () => {
    const custody = await serviceCustodyRow();
    let reEnveloped: string | null = null;
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.cloudflare_accounts")) {
        return [{ id: "facts", connection_id: CONNECTION_UUID, account_external_id: ACCOUNT_ID, parent_token_ref: "svc-token-id", token_status: "active", created_at: NOW.toISOString(), updated_at: NOW.toISOString() }];
      }
      if (text.includes("SELECT * FROM integrations.provider_credentials")) {
        return params[1] === "cloudflare_service_token" ? [custody] : [];
      }
      if (text.includes("INSERT INTO integrations.provider_credentials")) {
        reEnveloped = String(params[4]); // the new ciphertext envelope
        return [{ id: "cred", connection_id: params[1], kind: params[2] }];
      }
      return [];
    });
    const api = cloudflareApi();

    const outcome = await rotateConnectionSource(ENV, executor, cfConnection(), {
      fetchImpl: api.fetchImpl,
      mintLock: passthroughLock,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    // The roll used the CURRENT service token as bearer; the new value was
    // re-enveloped into custody.
    const put = api.calls.find((c) => c.method === "PUT")!;
    expect(put.auth).toBe("Bearer cf-service-CURRENT");
    const adapter = (await createEncryptionAdapter(KEY))!;
    expect(await adapter.decrypt(JSON.parse(reEnveloped!))).toBe("cf-service-ROLLED");
  });

  it("is rotation_unsupported when the connection has no provisioned service token (pasted/legacy)", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.cloudflare_accounts")) {
        // A pasted-token connection: facts row exists but no service token id.
        return [{ id: "facts", connection_id: CONNECTION_UUID, account_external_id: ACCOUNT_ID, parent_token_ref: null, token_status: "active", created_at: NOW.toISOString(), updated_at: NOW.toISOString() }];
      }
      return [];
    });
    const api = cloudflareApi();
    const outcome = await rotateConnectionSource(ENV, executor, cfConnection(), {
      fetchImpl: api.fetchImpl,
      mintLock: passthroughLock,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: false, reason: "rotation_unsupported" });
    expect(api.calls).toHaveLength(0);
  });

  it("is provider_error when the provider refuses the roll", async () => {
    const custody = await serviceCustodyRow();
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.cloudflare_accounts")) {
        return [{ id: "facts", connection_id: CONNECTION_UUID, account_external_id: ACCOUNT_ID, parent_token_ref: "svc-token-id", token_status: "active", created_at: NOW.toISOString(), updated_at: NOW.toISOString() }];
      }
      if (text.includes("SELECT * FROM integrations.provider_credentials")) {
        return params[1] === "cloudflare_service_token" ? [custody] : [];
      }
      return [];
    });
    const api = cloudflareApi(true);
    const outcome = await rotateConnectionSource(ENV, executor, cfConnection(), {
      fetchImpl: api.fetchImpl,
      mintLock: passthroughLock,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: false, reason: "provider_error" });
  });
});
