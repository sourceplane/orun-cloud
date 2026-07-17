// IH9 — Supabase connection-health cron (design §5.3): refresh-token
// liveness + project-list refresh. Verifies: dormant without the OAuth app;
// a refused refresh suspends + emits `integration.suspended` (reason
// "refresh_failed") WITHOUT zeroizing custody; a successful refresh
// re-envelopes the ROTATED refresh token BEFORE anything else can fail, then
// refreshes project facts best-effort. Repo failures are counted, never
// thrown.

import { runSupabaseHealth } from "@integrations-worker/health-supabase";
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

function fakeExecutor(
  respond: SqlResponder,
  ops?: string[],
): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      if (ops) {
        if (text.includes("INSERT INTO integrations.provider_credentials")) {
          ops.push("sql:re-envelope");
        }
        if (text.includes("INSERT INTO integrations.supabase_orgs")) ops.push("sql:upsert-org");
      }
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
    SUPABASE_OAUTH_CLIENT_ID: "sb-client-id",
    SUPABASE_OAUTH_CLIENT_SECRET: "sb-client-secret",
    ...overrides,
  } as unknown as Env;
}

type FetchCall = { method: string; url: string; body: string | null };

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | null,
  calls: FetchCall[],
  ops?: string[],
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: input,
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (ops) {
      if (input.includes("/v1/oauth/token")) ops.push("fetch:refresh");
      if (input.includes("/v1/projects")) ops.push("fetch:projects");
    }
    const response = handler(input, init);
    if (!response) throw new Error(`unexpected fetch: ${input}`);
    return response;
  };
}

async function custodyRow(connectionId: string, refreshToken: string): Promise<Record<string, unknown>> {
  const adapter = await createEncryptionAdapter(ENCRYPTION_KEY);
  const envelope = await adapter!.encrypt(refreshToken);
  return {
    id: "99999999-9999-4999-8999-999999999999",
    connection_id: connectionId,
    kind: "supabase_refresh_token",
    ciphertext: JSON.stringify(envelope),
    scopes: null,
    external_ref: "sb-org-ext-1",
    expires_at: null,
    rotated_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function orgRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    connection_id: CONNECTION_UUID,
    supabase_org_id: "sb-org-1",
    org_name: "Acme Org",
    granted_scopes: ["all"],
    projects: [{ ref: "stale-ref", name: "Stale" }],
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
    provider: "supabase",
    status: "suspended",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

const EVENT_ROW = { _event: { id: "evt", payload: "{}" }, _audit: { id: "aud", payload: "{}" } };

function refreshResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "fresh-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    }),
    { status: 200 },
  );
}

function projectsResponse(): Response {
  return new Response(JSON.stringify([{ id: "p1", ref: "proj-ref-1", name: "App" }]), {
    status: 200,
  });
}

// ── Tests ────────────────────────────────────────────────────

describe("runSupabaseHealth", () => {
  it("is dormant (checked 0, zero queries) until the Supabase OAuth app is configured", async () => {
    const { executor, queries } = fakeExecutor(() => []);
    const fetchImpl = fakeFetch(() => null, []);

    const summary = await runSupabaseHealth(
      createEnv({ SUPABASE_OAUTH_CLIENT_ID: undefined }),
      executor,
      { fetchImpl, now: NOW },
    );

    expect(summary).toEqual({ checked: 0, suspended: 0, refreshed: 0, failures: 0 });
    expect(queries).toHaveLength(0);
  });

  it("re-envelopes the rotated refresh token BEFORE the projects refresh, then updates facts", async () => {
    const custody = await custodyRow(CONNECTION_UUID, "old-refresh");
    const ops: string[] = [];
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.supabase_orgs t")) return [orgRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [custody];
      if (text.includes("INSERT INTO integrations.provider_credentials")) return [custody];
      if (text.includes("INSERT INTO integrations.supabase_orgs")) return [orgRow()];
      return [];
    }, ops);
    const calls: FetchCall[] = [];
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/v1/oauth/token")) return refreshResponse();
      if (url.includes("/v1/projects")) return projectsResponse();
      return null;
    }, calls, ops);

    const summary = await runSupabaseHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ checked: 1, suspended: 0, refreshed: 1, failures: 0 });

    // The refresh call spent the old token under our OAuth app credentials.
    const refresh = calls.find((c) => c.url.includes("/v1/oauth/token"));
    expect(refresh!.body).toContain("grant_type=refresh_token");
    expect(refresh!.body).toContain("refresh_token=old-refresh");
    expect(refresh!.body).toContain("client_id=sb-client-id");

    // Rotation custody: the re-envelope carries the ROTATED token under the
    // same kind + externalRef anchor.
    const reEnvelope = queries.find((q) =>
      q.text.includes("INSERT INTO integrations.provider_credentials"),
    );
    expect(reEnvelope).toBeDefined();
    expect(reEnvelope!.params[1]).toBe(CONNECTION_UUID);
    expect(reEnvelope!.params[2]).toBe("supabase_refresh_token");
    expect(reEnvelope!.params[6]).toBe("sb-org-ext-1");
    const adapter = await createEncryptionAdapter(ENCRYPTION_KEY);
    const envelope = JSON.parse(reEnvelope!.params[4] as string) as Parameters<
      NonNullable<typeof adapter>["decrypt"]
    >[0];
    await expect(adapter!.decrypt(envelope)).resolves.toBe("rotated-refresh");

    // Order invariant: the rotation must never be dropped — re-envelope
    // happens BEFORE the best-effort projects listing.
    expect(ops.indexOf("sql:re-envelope")).toBeGreaterThan(-1);
    expect(ops.indexOf("sql:re-envelope")).toBeLessThan(ops.indexOf("fetch:projects"));
    expect(ops.indexOf("fetch:projects")).toBeLessThan(ops.indexOf("sql:upsert-org"));

    // Project facts refreshed, connect-time anchors preserved.
    const upsertOrg = queries.find((q) => q.text.includes("INSERT INTO integrations.supabase_orgs"));
    expect(upsertOrg!.params[2]).toBe("sb-org-1");
    expect(upsertOrg!.params[3]).toBe("Acme Org");
    expect(upsertOrg!.params[4]).toBe(JSON.stringify(["all"]));
    expect(upsertOrg!.params[5]).toBe(JSON.stringify([{ ref: "proj-ref-1", name: "App" }]));
  });

  it("suspends + emits integration.suspended on a refused refresh and does NOT zeroize custody", async () => {
    const custody = await custodyRow(CONNECTION_UUID, "old-refresh");
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.supabase_orgs t")) return [orgRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [custody];
      if (text.includes("UPDATE integrations.connections")) return [connectionRow()];
      if (text.includes("WITH inserted_event")) return [EVENT_ROW];
      return [];
    });
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/v1/oauth/token")) return new Response(null, { status: 400 });
      return null;
    }, []);

    const summary = await runSupabaseHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ checked: 1, suspended: 1, refreshed: 0, failures: 0 });
    const suspend = queries.find((q) => q.text.includes("UPDATE integrations.connections"));
    expect(suspend!.params).toEqual([ORG_UUID, CONNECTION_UUID, "suspended"]);
    const event = queries.find((q) => q.text.includes("WITH inserted_event"));
    expect(event).toBeDefined();
    expect(event!.params[1]).toBe("integration.suspended");
    expect(event!.params[5]).toBe("system");
    const payload = JSON.parse(event!.params[19] as string) as Record<string, unknown>;
    expect(payload.provider).toBe("supabase");
    expect(payload.reason).toBe("refresh_failed"); // the console re-auth CTA rides this
    // Custody stays put — a re-auth overwrites it, nothing is zeroized or
    // re-enveloped here.
    expect(queries.some((q) => q.text.includes("DELETE FROM integrations.provider_credentials"))).toBe(false);
    expect(queries.some((q) => q.text.includes("INSERT INTO integrations.provider_credentials"))).toBe(false);
  });

  it("keeps the liveness verdict when the projects listing fails (best-effort facts)", async () => {
    const custody = await custodyRow(CONNECTION_UUID, "old-refresh");
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.supabase_orgs t")) return [orgRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [custody];
      if (text.includes("INSERT INTO integrations.provider_credentials")) return [custody];
      return [];
    });
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/v1/oauth/token")) return refreshResponse();
      if (url.includes("/v1/projects")) return new Response(null, { status: 500 });
      return null;
    }, []);

    const summary = await runSupabaseHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ checked: 1, suspended: 0, refreshed: 1, failures: 0 });
    // Rotation still re-enveloped; the facts upsert was skipped, not faked.
    expect(queries.some((q) => q.text.includes("INSERT INTO integrations.provider_credentials"))).toBe(true);
    expect(queries.some((q) => q.text.includes("INSERT INTO integrations.supabase_orgs"))).toBe(false);
  });

  it("skips non-active connections entirely", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.supabase_orgs t")) {
        return [orgRow({ connection_status: "suspended" })];
      }
      return [];
    });
    const calls: FetchCall[] = [];
    const fetchImpl = fakeFetch(() => null, calls);

    const summary = await runSupabaseHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary).toEqual({ checked: 0, suspended: 0, refreshed: 0, failures: 0 });
    expect(calls).toHaveLength(0);
    expect(queries.some((q) => q.text.includes("provider_credentials"))).toBe(false);
  });

  it("never throws on a repo failure mid-loop — counts it and finishes the batch", async () => {
    const custody1 = await custodyRow(CONNECTION_UUID, "old-refresh-1");
    const custody2 = await custodyRow(CONNECTION_2_UUID, "old-refresh-2");
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("FROM integrations.supabase_orgs t")) {
        return [
          orgRow(),
          orgRow({
            id: "77777777-7777-4777-8777-777777777777",
            connection_id: CONNECTION_2_UUID,
            supabase_org_id: "sb-org-2",
          }),
        ];
      }
      if (text.includes("FROM integrations.provider_credentials")) {
        return params[0] === CONNECTION_UUID ? [custody1] : [custody2];
      }
      if (text.includes("UPDATE integrations.connections")) throw new Error("db blip");
      if (text.includes("INSERT INTO integrations.provider_credentials")) return [custody2];
      if (text.includes("INSERT INTO integrations.supabase_orgs")) return [orgRow()];
      return [];
    });
    const fetchImpl = fakeFetch((url, init) => {
      if (url.includes("/v1/oauth/token")) {
        // The first connection's refresh is refused (drives the failing
        // suspend); the second refreshes fine.
        const body = typeof init?.body === "string" ? init.body : "";
        return body.includes("old-refresh-1") ? new Response(null, { status: 400 }) : refreshResponse();
      }
      if (url.includes("/v1/projects")) return projectsResponse();
      return null;
    }, []);

    const summary = await runSupabaseHealth(createEnv(), executor, { fetchImpl, now: NOW });

    expect(summary.checked).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.suspended).toBe(0); // the suspend never landed — not claimed
    expect(summary.refreshed).toBe(1); // the second row still processed
  });
});
