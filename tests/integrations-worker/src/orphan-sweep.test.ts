// IH9 — Cloudflare orphan-mint reconcile sweep. Verifies both reconcile
// directions against the `orun/{org}/{template}/{mintId}` naming contract:
// provider-side tokens that are ours-by-name with no live ledger row are
// revoked (orphans); pending ledger rows the provider no longer has are
// marked revoked (provider truth). Foreign-named tokens are never touched,
// and per-account failures never abort the sweep.

import { runOrphanSweep } from "@integrations-worker/orphan-sweep";
import { mintedCredentialPublicId, orgPublicId } from "@integrations-worker/ids";
import { createEncryptionAdapter } from "@integrations-worker/encryption";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const CONNECTION_2_UUID = "44444444-4444-4444-8444-444444444444";
const MINT_LIVE_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MINT_ORPHAN_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MINT_GONE_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MINT_EXPIRED_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ENCRYPTION_KEY = "ab".repeat(32);
const NOW = new Date("2026-07-12T04:00:00Z");

function mintName(mintUuid: string, template = "workers-deploy"): string {
  return `orun/${orgPublicId(ORG_UUID)}/${template}/${mintedCredentialPublicId(mintUuid)}`;
}

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

function createEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
  } as unknown as Env;
}

type FetchCall = { method: string; url: string };

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | null,
  calls: FetchCall[],
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: input });
    const response = handler(input, init);
    if (!response) throw new Error(`unexpected fetch: ${input}`);
    return response;
  };
}

async function custodyRow(connectionId: string, accountId: string): Promise<Record<string, unknown>> {
  const adapter = await createEncryptionAdapter(ENCRYPTION_KEY);
  const envelope = await adapter!.encrypt(`parent-token-${accountId}`);
  return {
    id: "99999999-9999-4999-8999-999999999999",
    connection_id: connectionId,
    kind: "cloudflare_parent_token",
    ciphertext: JSON.stringify(envelope),
    scopes: null,
    external_ref: accountId,
    expires_at: null,
    rotated_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function accountRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    connection_id: CONNECTION_UUID,
    account_external_id: "cf-acct-1",
    account_name: "Acme",
    parent_token_ref: "parent-ref-1",
    granted_policies: null,
    token_status: "active",
    parent_expires_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    org_id: ORG_UUID,
    connection_status: "active",
    ...overrides,
  };
}

function mintRow(id: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    org_id: ORG_UUID,
    connection_id: CONNECTION_UUID,
    provider: "cloudflare",
    template: "workers-deploy",
    params: null,
    purpose: "api",
    requested_by: null,
    run_id: null,
    job_id: null,
    ttl_seconds: 900,
    provider_ref: null,
    minted_at: NOW.toISOString(),
    expires_at: NOW.toISOString(),
    revoked_at: null,
    revoke_status: "pending",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function tokensResponse(tokens: Array<Record<string, unknown>>): Response {
  return new Response(
    JSON.stringify({ success: true, result: tokens, result_info: { total_pages: 1 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ── Tests ────────────────────────────────────────────────────

describe("runOrphanSweep", () => {
  it("reconciles both directions and never touches foreign-named tokens", async () => {
    const custody = await custodyRow(CONNECTION_UUID, "cf-acct-1");
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.cloudflare_accounts t")) return [accountRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [custody];
      if (text.includes("revoke_status = 'pending'")) {
        return [
          mintRow(MINT_LIVE_UUID, { provider_ref: "tok-live" }),
          mintRow(MINT_GONE_UUID, { provider_ref: "tok-gone" }),
        ];
      }
      if (text.includes("WHERE org_id = $1 AND id = $2")) {
        if (params[1] === MINT_EXPIRED_UUID) {
          return [mintRow(MINT_EXPIRED_UUID, { revoke_status: "expired" })];
        }
        return []; // MINT_ORPHAN_UUID: no ledger row at all
      }
      if (text.includes("UPDATE integrations.minted_credentials")) {
        return [mintRow(MINT_GONE_UUID, { revoke_status: "revoked" })];
      }
      return [];
    });
    const calls: FetchCall[] = [];
    const fetchImpl = fakeFetch((url, init) => {
      if (url.includes("/accounts/cf-acct-1/tokens?")) {
        return tokensResponse([
          { id: "tok-live", name: mintName(MINT_LIVE_UUID), status: "active" },
          { id: "tok-orphan", name: mintName(MINT_ORPHAN_UUID), status: "active" },
          { id: "tok-expired", name: mintName(MINT_EXPIRED_UUID), status: "active" },
          { id: "tok-foreign", name: "customer-made-token", status: "active" },
          { id: "tok-foreign2", name: "orun/not-a-mint", status: "active" },
          // SI5 invariant: the durable service identity is named
          // `orun/{org}/service` — it must NEVER parse as a mint and NEVER
          // be revoked by the sweep.
          { id: "svc-token-id", name: `orun/${orgPublicId(ORG_UUID)}/service`, status: "active" },
        ]);
      }
      if (init?.method === "DELETE" && url.includes("/accounts/cf-acct-1/tokens/")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return null;
    }, calls);

    const summary = await runOrphanSweep(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ accounts: 1, orphansRevoked: 2, ledgerReconciled: 1, failures: 0 });

    // Provider → ledger: only the ours-by-name tokens with a dead/missing
    // ledger row were revoked — never the live one, never foreign names.
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deletes).toHaveLength(2);
    expect(deletes.some((u) => u.endsWith("/tokens/tok-orphan"))).toBe(true);
    expect(deletes.some((u) => u.endsWith("/tokens/tok-expired"))).toBe(true);
    expect(deletes.some((u) => u.includes("tok-foreign"))).toBe(false);
    expect(deletes.some((u) => u.includes("tok-live"))).toBe(false);
    // The service identity survives every sweep (SI5).
    expect(deletes.some((u) => u.includes("svc-token-id"))).toBe(false);
    // The revoke ran under the decrypted parent token.
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);

    // Ledger → provider: the pending mint the provider no longer has was
    // closed as revoked at sweep time.
    const mark = queries.find((q) => q.text.includes("UPDATE integrations.minted_credentials"));
    expect(mark).toBeDefined();
    expect(mark!.params).toEqual([MINT_GONE_UUID, "revoked", NOW]);
  });

  it("sends the revoke with the parent credential as bearer", async () => {
    const custody = await custodyRow(CONNECTION_UUID, "cf-acct-1");
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.cloudflare_accounts t")) return [accountRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [custody];
      return [];
    });
    const auths: Array<string | null> = [];
    const calls: FetchCall[] = [];
    const fetchImpl = fakeFetch((url, init) => {
      if (url.includes("/tokens?")) {
        return tokensResponse([
          { id: "tok-orphan", name: mintName(MINT_ORPHAN_UUID), status: "active" },
        ]);
      }
      if (init?.method === "DELETE") {
        auths.push(new Headers(init.headers).get("authorization"));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return null;
    }, calls);

    const summary = await runOrphanSweep(createEnv(), executor, { fetchImpl, now: NOW });
    expect(summary.orphansRevoked).toBe(1);
    expect(auths).toEqual(["Bearer parent-token-cf-acct-1"]);
  });

  it("skips non-active connections without touching custody or the provider", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.cloudflare_accounts t")) {
        return [accountRow({ connection_status: "suspended" })];
      }
      return [];
    });
    const calls: FetchCall[] = [];
    const fetchImpl = fakeFetch(() => null, calls);

    const summary = await runOrphanSweep(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ accounts: 0, orphansRevoked: 0, ledgerReconciled: 0, failures: 0 });
    expect(calls).toHaveLength(0);
    expect(queries.some((q) => q.text.includes("provider_credentials"))).toBe(false);
  });

  it("counts a provider-API failure and continues to the next account", async () => {
    const custody1 = await custodyRow(CONNECTION_UUID, "cf-acct-1");
    const custody2 = await custodyRow(CONNECTION_2_UUID, "cf-acct-2");
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.cloudflare_accounts t")) {
        return [
          accountRow(),
          accountRow({
            id: "77777777-7777-4777-8777-777777777777",
            connection_id: CONNECTION_2_UUID,
            account_external_id: "cf-acct-2",
          }),
        ];
      }
      if (text.includes("FROM integrations.provider_credentials")) {
        return params[0] === CONNECTION_UUID ? [custody1] : [custody2];
      }
      return [];
    });
    const calls: FetchCall[] = [];
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/accounts/cf-acct-1/tokens?")) return new Response(null, { status: 500 });
      if (url.includes("/accounts/cf-acct-2/tokens?")) return tokensResponse([]);
      return null;
    }, calls);

    const summary = await runOrphanSweep(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ accounts: 2, orphansRevoked: 0, ledgerReconciled: 0, failures: 1 });
    // The second account was still swept after the first one's API failure.
    expect(calls.some((c) => c.url.includes("cf-acct-2"))).toBe(true);
  });

  it("never throws when the repo fails mid-loop — counts and finishes", async () => {
    const custody1 = await custodyRow(CONNECTION_UUID, "cf-acct-1");
    const custody2 = await custodyRow(CONNECTION_2_UUID, "cf-acct-2");
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.cloudflare_accounts t")) {
        return [
          accountRow(),
          accountRow({
            id: "77777777-7777-4777-8777-777777777777",
            connection_id: CONNECTION_2_UUID,
            account_external_id: "cf-acct-2",
          }),
        ];
      }
      if (text.includes("FROM integrations.provider_credentials")) {
        return params[0] === CONNECTION_UUID ? [custody1] : [custody2];
      }
      if (text.includes("revoke_status = 'pending'") && params[0] === CONNECTION_UUID) {
        throw new Error("db blip");
      }
      return [];
    });
    const calls: FetchCall[] = [];
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/tokens?")) return tokensResponse([]);
      return null;
    }, calls);

    const summary = await runOrphanSweep(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary.failures).toBe(1);
    expect(summary.accounts).toBe(2);
    expect(calls.some((c) => c.url.includes("cf-acct-2"))).toBe(true);
  });
});
