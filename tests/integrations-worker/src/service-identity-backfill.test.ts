// SI3 (sub-epics/service-identity-bootstrap): the backfill sweep that
// upgrades EXISTING Cloudflare OAuth connections from user-derived
// refresh-token custody to the provisioned account-owned service token.
// Rules under test:
//   * The upgrade runs under the connection mint lock and swaps custody only
//     after a successful probe of the freshly provisioned token.
//   * Crash-safety: the rotated refresh token is re-enveloped BEFORE any
//     fallible step, so every failure leaves valid refresh custody behind.
//   * SI-D1: a bootstrap grant that cannot self-provision counts
//     grantInsufficient and the connection keeps working on refresh custody.
//   * Idempotence: an already-migrated connection only has its lingering
//     refresh row dropped; the sweep self-quiesces.

import {
  runServiceIdentityBackfill,
  SERVICE_IDENTITY_BACKFILL_LIMIT,
} from "@integrations-worker/service-identity-backfill";
import { serviceIdentityPermissionGroups } from "@integrations-worker/providers/cloudflare";
import { createEncryptionAdapter, type CiphertextEnvelope } from "@integrations-worker/encryption";
import type { Env } from "@integrations-worker/env";
import type { MintLockRunner } from "@integrations-worker/mint-lock";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const KEY = "cd".repeat(32);
const ACCOUNT_ID = "9a7806061c88ada191ed06f989cc3dac";
const NOW = new Date("2026-07-17T15:30:00Z");

const ALL_GROUPS = serviceIdentityPermissionGroups().map((name, i) => ({ id: `pg-${i}`, name }));

const ENV = {
  SECRET_ENCRYPTION_KEY: KEY,
  CLOUDFLARE_OAUTH_CLIENT_ID: "cf-cid",
  CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-cs",
} as unknown as Env;

type QueryRecord = { text: string; params: unknown[] };

/** In-memory serializing lock — records which keys were held. */
function serializingLock(held: string[]): MintLockRunner {
  return async (key, fn) => {
    held.push(key);
    return { ok: true, value: await fn() };
  };
}

function sweepRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "facts-row-id",
    connection_id: CONNECTION_UUID,
    account_external_id: ACCOUNT_ID,
    account_name: "Acme Infra",
    parent_token_ref: null,
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

async function custodyRow(kind: string, plaintext: string): Promise<Record<string, unknown>> {
  const adapter = (await createEncryptionAdapter(KEY))!;
  return {
    id: `cred-${kind}`,
    connection_id: CONNECTION_UUID,
    kind,
    ciphertext: JSON.stringify(await adapter.encrypt(plaintext)),
    external_ref: ACCOUNT_ID,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

interface Harness {
  executor: SqlExecutor;
  queries: QueryRecord[];
  custodyInserts: unknown[][];
  custodyDeletes: unknown[][];
  factsUpserts: unknown[][];
}

function harness(custodyByKind: Record<string, Record<string, unknown>>): Harness {
  const queries: QueryRecord[] = [];
  const custodyInserts: unknown[][] = [];
  const custodyDeletes: unknown[][] = [];
  const factsUpserts: unknown[][] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      const p = params ?? [];
      queries.push({ text, params: p });
      let rows: Record<string, unknown>[] = [];
      if (text.includes("FROM integrations.cloudflare_accounts t")) {
        rows = [sweepRow()];
      } else if (text.includes("SELECT * FROM integrations.provider_credentials")) {
        const found = custodyByKind[String(p[1])];
        rows = found ? [found] : [];
      } else if (text.includes("INSERT INTO integrations.provider_credentials")) {
        custodyInserts.push(p);
        // Track upserts so later reads see the new custody state.
        custodyByKind[String(p[2])] = {
          id: p[0] as string,
          connection_id: p[1],
          kind: p[2],
          credential_class: p[3],
          ciphertext: p[4],
          external_ref: p[6],
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        };
        rows = [custodyByKind[String(p[2])]!];
      } else if (text.includes("DELETE FROM integrations.provider_credentials")) {
        custodyDeletes.push(p);
        delete custodyByKind[String(p[1])];
      } else if (text.includes("INSERT INTO integrations.cloudflare_accounts")) {
        factsUpserts.push(p);
        rows = [sweepRow({ parent_token_ref: p[4] })];
      } else if (text.includes("WITH inserted_event")) {
        rows = [{ _event: { id: "evt", payload: {} }, _audit: { id: "aud", payload: {} } }];
      }
      return { rows: rows as unknown as T[], rowCount: rows.length };
    },
  };
  return { executor, queries, custodyInserts, custodyDeletes, factsUpserts };
}

/** Fake Cloudflare API: refresh (rotates), groups, token create, probe
 *  verify, delete. Records calls. */
function cloudflareApi(overrides?: {
  groups?: Array<Record<string, unknown>>;
  probeStatus?: string;
  refreshFails?: boolean;
}): {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; method: string; auth: string | null; body: string | null }>;
} {
  const calls: Array<{ url: string; method: string; auth: string | null; body: string | null }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (input.includes("/oauth2/token")) {
      if (overrides?.refreshFails) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: "cf-access-SECRET",
        refresh_token: "cf-refresh-NEW",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (input.includes("/user/tokens/permission_groups")) {
      return Response.json({ success: true, result: overrides?.groups ?? ALL_GROUPS });
    }
    if (input.includes("/user/tokens/verify")) {
      return Response.json({
        success: true,
        result: { id: "svc-token-id", status: overrides?.probeStatus ?? "active", expires_on: null },
      });
    }
    if (input.includes(`/accounts/${ACCOUNT_ID}/tokens`) && (init?.method ?? "GET") === "POST") {
      return Response.json({ success: true, result: { id: "svc-token-id", value: "cf-service-SECRET" } });
    }
    if ((init?.method ?? "GET") === "DELETE") {
      return Response.json({ success: true, result: { id: "svc-token-id" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

describe("runServiceIdentityBackfill (SI3)", () => {
  it("upgrades a refresh-custody connection under the mint lock: provision, probe, swap, retire, event", async () => {
    const custody = { cloudflare_refresh_token: await custodyRow("cloudflare_refresh_token", "cf-refresh-OLD") };
    const h = harness(custody);
    const api = cloudflareApi();
    const held: string[] = [];

    const summary = await runServiceIdentityBackfill(ENV, h.executor, {
      fetchImpl: api.fetchImpl,
      now: NOW,
      mintLock: serializingLock(held),
    });
    expect(summary).toEqual({ scanned: 1, upgraded: 1, alreadyMigrated: 0, grantInsufficient: 0, failures: 0 });
    expect(held).toEqual([CONNECTION_UUID]);

    // The rotated refresh token was re-enveloped BEFORE provisioning (crash
    // safety), then the service token landed, then refresh custody retired.
    const kinds = h.custodyInserts.map((p) => p[2]);
    expect(kinds).toEqual(["cloudflare_refresh_token", "cloudflare_service_token"]);
    const adapter = (await createEncryptionAdapter(KEY))!;
    expect(
      await adapter.decrypt(JSON.parse(h.custodyInserts[1]![4] as string) as CiphertextEnvelope),
    ).toBe("cf-service-SECRET");
    expect(h.custodyDeletes).toContainEqual([CONNECTION_UUID, "cloudflare_refresh_token"]);

    // The probe ran with the NEW token before any swap.
    const probe = api.calls.find((c) => c.url.includes("/user/tokens/verify"))!;
    expect(probe.auth).toBe("Bearer cf-service-SECRET");

    // Facts carry the identity's provider-side id.
    expect(h.factsUpserts[0]![4]).toBe("svc-token-id");

    // The upgrade event names the transition; nothing leaks values.
    const eventJson = JSON.stringify(h.queries.filter((q) => q.text.includes("WITH inserted_event")).map((q) => q.params));
    expect(eventJson).toContain("integration.connection.upgraded");
    expect(eventJson).toContain("cloudflare_service_token");
    expect(eventJson).not.toContain("cf-service-SECRET");
    expect(eventJson).not.toContain("cf-refresh-NEW");
  });

  it("counts grantInsufficient and keeps (re-enveloped) refresh custody when the grant cannot self-provision", async () => {
    const custody = { cloudflare_refresh_token: await custodyRow("cloudflare_refresh_token", "cf-refresh-OLD") };
    const h = harness(custody);
    const api = cloudflareApi({ groups: ALL_GROUPS.slice(0, 2) });

    const summary = await runServiceIdentityBackfill(ENV, h.executor, {
      fetchImpl: api.fetchImpl,
      now: NOW,
      mintLock: serializingLock([]),
    });
    expect(summary).toEqual({ scanned: 1, upgraded: 0, alreadyMigrated: 0, grantInsufficient: 1, failures: 0 });

    // Rotation landed; no service custody, no retirement, no token created.
    expect(h.custodyInserts.map((p) => p[2])).toEqual(["cloudflare_refresh_token"]);
    const adapter = (await createEncryptionAdapter(KEY))!;
    expect(
      await adapter.decrypt(JSON.parse(h.custodyInserts[0]![4] as string) as CiphertextEnvelope),
    ).toBe("cf-refresh-NEW");
    expect(h.custodyDeletes).toEqual([]);
    expect(api.calls.some((c) => c.method === "POST" && c.url.includes("/tokens"))).toBe(false);
  });

  it("deletes the provisioned token and keeps refresh custody when the probe refuses it", async () => {
    const custody = { cloudflare_refresh_token: await custodyRow("cloudflare_refresh_token", "cf-refresh-OLD") };
    const h = harness(custody);
    const api = cloudflareApi({ probeStatus: "disabled" });

    const summary = await runServiceIdentityBackfill(ENV, h.executor, {
      fetchImpl: api.fetchImpl,
      now: NOW,
      mintLock: serializingLock([]),
    });
    expect(summary.failures).toBe(1);
    expect(summary.upgraded).toBe(0);

    // The unusable token was cleaned up; custody still refresh-only.
    const del = api.calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toContain("/tokens/svc-token-id");
    expect(h.custodyInserts.map((p) => p[2])).toEqual(["cloudflare_refresh_token"]);
    expect(h.custodyDeletes).toEqual([]);
  });

  it("is idempotent: an already-migrated connection only drops a lingering refresh row", async () => {
    const custody = {
      cloudflare_service_token: await custodyRow("cloudflare_service_token", "cf-service-SECRET"),
      cloudflare_refresh_token: await custodyRow("cloudflare_refresh_token", "cf-refresh-STALE"),
    };
    const h = harness(custody);
    const api = cloudflareApi();

    const summary = await runServiceIdentityBackfill(ENV, h.executor, {
      fetchImpl: api.fetchImpl,
      now: NOW,
      mintLock: serializingLock([]),
    });
    expect(summary).toEqual({ scanned: 1, upgraded: 0, alreadyMigrated: 1, grantInsufficient: 0, failures: 0 });
    expect(h.custodyDeletes).toContainEqual([CONNECTION_UUID, "cloudflare_refresh_token"]);
    // No provider traffic at all.
    expect(api.calls).toEqual([]);
  });

  it("no-ops without an OAuth client (nothing to upgrade FROM)", async () => {
    const h = harness({});
    const api = cloudflareApi();
    const summary = await runServiceIdentityBackfill(
      { SECRET_ENCRYPTION_KEY: KEY } as unknown as Env,
      h.executor,
      { fetchImpl: api.fetchImpl, now: NOW, mintLock: serializingLock([]) },
    );
    expect(summary.scanned).toBe(0);
    expect(h.queries).toEqual([]);
  });

  it("bounds each run", () => {
    expect(SERVICE_IDENTITY_BACKFILL_LIMIT).toBeGreaterThan(0);
  });
});
