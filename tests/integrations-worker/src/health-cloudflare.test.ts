// IH9 — Cloudflare connection-health cron (design §5.2). Verifies the three
// verdicts: invalid parent (or missing custody) → facts flip to invalid +
// connection suspended + `integration.suspended` event carrying the re-auth
// reason; parent expiring within 14 days → facts flip to expiring; healthy →
// facts stay active with a best-effort granted-policies refresh. Repo
// failures are counted, never thrown.

import {
  runCloudflareHealth,
  PARENT_EXPIRING_WINDOW_DAYS,
} from "@integrations-worker/health-cloudflare";
import { createEncryptionAdapter } from "@integrations-worker/encryption";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const CONNECTION_2_UUID = "44444444-4444-4444-8444-444444444444";
const ENCRYPTION_KEY = "ab".repeat(32);
const NOW = new Date("2026-07-12T04:00:00Z");

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

type FetchCall = { method: string; url: string; auth: string | null };

function fakeFetch(
  handler: (url: string, auth: string | null) => Response | null,
  calls: FetchCall[],
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method: init?.method ?? "GET", url: input, auth });
    const response = handler(input, auth);
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
    granted_policies: [{ old: true }],
    token_status: "active",
    parent_expires_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    org_id: ORG_UUID,
    connection_status: "active",
    ...overrides,
  };
}

function connectionRow(): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "cloudflare",
    status: "suspended",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

const EVENT_ROW = { _event: { id: "evt", payload: "{}" }, _audit: { id: "aud", payload: "{}" } };

function verifyResponse(status: string, expiresOn: string | null): Response {
  return new Response(
    JSON.stringify({ success: true, result: { id: "parent-tok-id", status, expires_on: expiresOn } }),
    { status: 200 },
  );
}

function policiesResponse(policies: unknown[]): Response {
  return new Response(JSON.stringify({ success: true, result: { policies } }), { status: 200 });
}

function baseResponder(custody: Record<string, unknown>): SqlResponder {
  return (text, params) => {
    if (text.includes("FROM integrations.cloudflare_accounts t")) return [accountRow()];
    // Honor the `kind = $2` filter so the OAuth-refresh probe (which runs
    // first) misses and readParentCredential falls through to the parent token.
    if (text.includes("FROM integrations.provider_credentials")) {
      return params[1] === custody.kind ? [custody] : [];
    }
    if (text.includes("INSERT INTO integrations.cloudflare_accounts")) return [accountRow()];
    if (text.includes("UPDATE integrations.connections")) return [connectionRow()];
    if (text.includes("WITH inserted_event")) return [EVENT_ROW];
    return [];
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("runCloudflareHealth", () => {
  it("keeps a healthy parent active and refreshes granted_policies when the read succeeds", async () => {
    const custody = await custodyRow(CONNECTION_UUID, "cf-acct-1");
    const { executor, queries } = fakeExecutor(baseResponder(custody));
    const calls: FetchCall[] = [];
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/user/tokens/verify")) return verifyResponse("active", "2026-12-01T00:00:00Z");
      if (url.includes("/user/tokens/parent-tok-id")) return policiesResponse([{ effect: "allow" }]);
      return null;
    }, calls);

    const summary = await runCloudflareHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ checked: 1, invalid: 0, expiring: 0, failures: 0 });
    const upsert = queries.find((q) => q.text.includes("INSERT INTO integrations.cloudflare_accounts"));
    expect(upsert).toBeDefined();
    // Connect-time anchors pass through untouched; the cron owns only health.
    expect(upsert!.params[2]).toBe("cf-acct-1");
    expect(upsert!.params[3]).toBe("Acme");
    expect(upsert!.params[4]).toBe("parent-ref-1");
    expect(upsert!.params[5]).toBe(JSON.stringify([{ effect: "allow" }]));
    expect(upsert!.params[6]).toBe("active");
    expect(upsert!.params[7]).toEqual(new Date("2026-12-01T00:00:00Z"));
    // No suspend, no event.
    expect(queries.some((q) => q.text.includes("UPDATE integrations.connections"))).toBe(false);
    expect(queries.some((q) => q.text.includes("WITH inserted_event"))).toBe(false);
  });

  it("keeps the previous granted_policies when the policy read fails", async () => {
    const custody = await custodyRow(CONNECTION_UUID, "cf-acct-1");
    const { executor, queries } = fakeExecutor(baseResponder(custody));
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/user/tokens/verify")) return verifyResponse("active", null);
      if (url.includes("/user/tokens/parent-tok-id")) return new Response(null, { status: 500 });
      return null;
    }, []);

    const summary = await runCloudflareHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ checked: 1, invalid: 0, expiring: 0, failures: 0 });
    const upsert = queries.find((q) => q.text.includes("INSERT INTO integrations.cloudflare_accounts"));
    expect(upsert!.params[5]).toBe(JSON.stringify([{ old: true }]));
    expect(upsert!.params[6]).toBe("active");
    expect(upsert!.params[7]).toBeNull(); // no expiry on the parent is fine
  });

  it("suspends the connection and emits integration.suspended when the parent fails verification", async () => {
    const custody = await custodyRow(CONNECTION_UUID, "cf-acct-1");
    const { executor, queries } = fakeExecutor(baseResponder(custody));
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/user/tokens/verify")) return new Response(null, { status: 401 });
      return null;
    }, []);

    const summary = await runCloudflareHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ checked: 1, invalid: 1, expiring: 0, failures: 0 });
    const upsert = queries.find((q) => q.text.includes("INSERT INTO integrations.cloudflare_accounts"));
    expect(upsert!.params[6]).toBe("invalid");
    const suspend = queries.find((q) => q.text.includes("UPDATE integrations.connections"));
    expect(suspend).toBeDefined();
    expect(suspend!.params).toEqual([ORG_UUID, CONNECTION_UUID, "suspended"]);
    const event = queries.find((q) => q.text.includes("WITH inserted_event"));
    expect(event).toBeDefined();
    expect(event!.params[1]).toBe("integration.suspended");
    expect(event!.params[5]).toBe("system"); // actorType
    expect(event!.params[13]).toBe(CONNECTION_UUID); // subjectId
    const payload = JSON.parse(event!.params[19] as string) as Record<string, unknown>;
    expect(payload.provider).toBe("cloudflare");
    expect(payload.reason).toBe("parent_token_invalid"); // the console re-auth CTA rides this
  });

  it("treats a verified-but-not-active parent as invalid", async () => {
    const custody = await custodyRow(CONNECTION_UUID, "cf-acct-1");
    const { executor, queries } = fakeExecutor(baseResponder(custody));
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/user/tokens/verify")) return verifyResponse("disabled", null);
      return null;
    }, []);

    const summary = await runCloudflareHealth(createEnv(), executor, { fetchImpl, now: NOW });
    expect(summary.invalid).toBe(1);
    expect(queries.some((q) => q.text.includes("UPDATE integrations.connections"))).toBe(true);
  });

  it("treats missing custody as invalid without calling the provider", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.cloudflare_accounts t")) return [accountRow()];
      if (text.includes("FROM integrations.provider_credentials")) return []; // no custody row
      if (text.includes("INSERT INTO integrations.cloudflare_accounts")) return [accountRow()];
      if (text.includes("UPDATE integrations.connections")) return [connectionRow()];
      if (text.includes("WITH inserted_event")) return [EVENT_ROW];
      return [];
    });
    const calls: FetchCall[] = [];
    const fetchImpl = fakeFetch(() => null, calls);

    const summary = await runCloudflareHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ checked: 1, invalid: 1, expiring: 0, failures: 0 });
    expect(calls).toHaveLength(0);
  });

  it("flags expiring exactly at the 14-day window boundary, not beyond it", async () => {
    const atBoundary = new Date(
      NOW.getTime() + PARENT_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const beyondBoundary = new Date(
      NOW.getTime() + (PARENT_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000 + 60_000),
    ).toISOString();
    const custody1 = await custodyRow(CONNECTION_UUID, "cf-acct-1");
    const custody2 = await custodyRow(CONNECTION_2_UUID, "cf-acct-2");
    const { executor, queries } = fakeExecutor((text, params) => {
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
        if (params[1] !== "cloudflare_parent_token") return [];
        return params[0] === CONNECTION_UUID ? [custody1] : [custody2];
      }
      if (text.includes("INSERT INTO integrations.cloudflare_accounts")) return [accountRow()];
      return [];
    });
    const fetchImpl = fakeFetch((url, auth) => {
      if (url.includes("/user/tokens/verify")) {
        return auth === "Bearer parent-token-cf-acct-1"
          ? verifyResponse("active", atBoundary)
          : verifyResponse("active", beyondBoundary);
      }
      if (url.includes("/user/tokens/parent-tok-id")) return policiesResponse([]);
      return null;
    }, []);

    const summary = await runCloudflareHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ checked: 2, invalid: 0, expiring: 1, failures: 0 });
    const upserts = queries.filter((q) =>
      q.text.includes("INSERT INTO integrations.cloudflare_accounts"),
    );
    expect(upserts.map((q) => q.params[6]).sort()).toEqual(["active", "expiring"]);
    const expiringUpsert = upserts.find((q) => q.params[6] === "expiring")!;
    expect(expiringUpsert.params[7]).toEqual(new Date(atBoundary));
  });

  it("skips non-active connections entirely", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.cloudflare_accounts t")) {
        return [accountRow({ connection_status: "revoked" })];
      }
      return [];
    });
    const calls: FetchCall[] = [];
    const fetchImpl = fakeFetch(() => null, calls);

    const summary = await runCloudflareHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ checked: 0, invalid: 0, expiring: 0, failures: 0 });
    expect(calls).toHaveLength(0);
    expect(queries.some((q) => q.text.includes("provider_credentials"))).toBe(false);
  });

  it("never throws on a repo failure mid-loop — counts it and finishes the batch", async () => {
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
        if (params[1] !== "cloudflare_parent_token") return [];
        return params[0] === CONNECTION_UUID ? [custody1] : [custody2];
      }
      if (text.includes("UPDATE integrations.connections")) throw new Error("db blip");
      if (text.includes("INSERT INTO integrations.cloudflare_accounts")) return [accountRow()];
      if (text.includes("WITH inserted_event")) return [EVENT_ROW];
      return [];
    });
    const fetchImpl = fakeFetch((url, auth) => {
      if (url.includes("/user/tokens/verify")) {
        // First parent invalid (drives the failing suspend), second healthy.
        return auth === "Bearer parent-token-cf-acct-1"
          ? new Response(null, { status: 401 })
          : verifyResponse("active", null);
      }
      if (url.includes("/user/tokens/parent-tok-id")) return policiesResponse([]);
      return null;
    }, []);

    const summary = await runCloudflareHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary.checked).toBe(2);
    expect(summary.invalid).toBe(1);
    expect(summary.failures).toBe(1);
  });
});
