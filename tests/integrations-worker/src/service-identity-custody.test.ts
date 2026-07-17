// SI1 (sub-epics/service-identity-bootstrap): credential classes + the
// custody candidate-order flip. Rules under test:
//   * Cloudflare custody prefers the provisioned service token over the
//     pasted parent token over the DEPRECATED user-derived refresh token —
//     dual-read makes the SI3 rollout a no-op for un-migrated connections.
//   * The kind → credential-class mapping is total and matches migration
//     840's backfill: bootstrap material (OAuth tokens, PKCE verifiers) is
//     identity-class; durable operating custody is infrastructure-class.
//   * Custody upserts stamp credential_class.

import {
  readParentCredential,
  readParentCredentialOfKind,
  PARENT_CREDENTIAL_KIND_CANDIDATES,
} from "@integrations-worker/custody";
import type { Env } from "@integrations-worker/env";
import {
  createIntegrationHubRepository,
  CREDENTIAL_CLASS_BY_KIND,
  type ProviderCredentialKind,
} from "@saas/db/integrations";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const CONNECTION_ID = asUuid(CONNECTION_UUID);
const KEY = "ab".repeat(32);
const NOW = new Date("2026-07-17T13:00:00Z");

const ENV = { SECRET_ENCRYPTION_KEY: KEY } as unknown as Env;

type QueryRecord = { text: string; params: unknown[] };

function fakeExecutor(
  respond: (text: string, params: unknown[]) => Record<string, unknown>[] | null,
): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const rows = respond(text, params ?? []);
      return { rows: (rows ?? []) as unknown as T[], rowCount: (rows ?? []).length };
    },
  };
  return { executor, queries };
}

async function custodyRow(kind: ProviderCredentialKind, plaintext: string) {
  const { createEncryptionAdapter } = await import("@integrations-worker/encryption");
  const adapter = (await createEncryptionAdapter(KEY))!;
  return {
    id: `cred-${kind}`,
    connection_id: CONNECTION_UUID,
    kind,
    credential_class: CREDENTIAL_CLASS_BY_KIND[kind],
    ciphertext: JSON.stringify(await adapter.encrypt(plaintext)),
    external_ref: "acc-1",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

describe("SI1/SI5 custody candidate order", () => {
  it("declares service identity → parent token — the deprecated refresh token is structurally absent (SI5)", () => {
    expect(PARENT_CREDENTIAL_KIND_CANDIDATES.cloudflare).toEqual([
      "cloudflare_service_token",
      "cloudflare_parent_token",
    ]);
  });

  it("prefers the provisioned service token when custody holds every posture", async () => {
    const rows: Record<string, Record<string, unknown>> = {
      cloudflare_service_token: await custodyRow("cloudflare_service_token", "svc-token"),
      cloudflare_parent_token: await custodyRow("cloudflare_parent_token", "pasted-token"),
      cloudflare_refresh_token: await custodyRow("cloudflare_refresh_token", "refresh-token"),
    };
    const { executor } = fakeExecutor((text, params) => {
      if (!text.includes("FROM integrations.provider_credentials")) return [];
      const row = rows[String(params[1])];
      return row ? [row] : [];
    });
    const parent = await readParentCredential(ENV, executor, CONNECTION_ID, "cloudflare");
    expect(parent).toBeTruthy();
    expect(parent!.kind).toBe("cloudflare_service_token");
    expect(parent!.credential).toBe("svc-token");
  });

  it("a refresh-only connection mints NOTHING via candidates (SI5) — lifecycle surfaces read the kind explicitly", async () => {
    const refreshOnly = await custodyRow("cloudflare_refresh_token", "refresh-token");
    const reads: string[] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (!text.includes("FROM integrations.provider_credentials")) return [];
      reads.push(String(params[1]));
      return String(params[1]) === "cloudflare_refresh_token" ? [refreshOnly] : [];
    });
    // The mint path cannot see user-derived custody at all.
    const parent = await readParentCredential(ENV, executor, CONNECTION_ID, "cloudflare");
    expect(parent).toBeNull();
    expect(reads).toEqual(["cloudflare_service_token", "cloudflare_parent_token"]);

    // The backfill/health surfaces still can — explicitly, by kind.
    const explicit = await readParentCredentialOfKind(
      ENV,
      executor,
      CONNECTION_ID,
      "cloudflare_refresh_token",
    );
    expect(explicit!.kind).toBe("cloudflare_refresh_token");
    expect(explicit!.credential).toBe("refresh-token");
  });
});

describe("SI1 credential classes", () => {
  it("classifies every custody kind, matching migration 840's backfill", () => {
    expect(CREDENTIAL_CLASS_BY_KIND).toEqual({
      slack_bot_token: "infrastructure",
      cloudflare_parent_token: "infrastructure",
      cloudflare_service_token: "infrastructure",
      cloudflare_refresh_token: "identity",
      cloudflare_pkce_verifier: "identity",
      supabase_refresh_token: "identity",
      supabase_access_token_cache: "identity",
      supabase_pkce_verifier: "identity",
      supabase_project_secret: "infrastructure",
    });
  });

  it("stamps credential_class on custody upserts", async () => {
    const { executor, queries } = fakeExecutor((text, params) =>
      text.includes("INSERT INTO integrations.provider_credentials")
        ? [
            {
              id: params[0],
              connection_id: params[1],
              kind: params[2],
              credential_class: params[3],
              ciphertext: params[4],
              external_ref: params[6],
              created_at: NOW.toISOString(),
              updated_at: NOW.toISOString(),
            },
          ]
        : [],
    );
    const repo = createIntegrationHubRepository(executor);
    const upserted = await repo.upsertProviderCredential({
      id: "00000000-0000-4000-8000-000000000010",
      connectionId: CONNECTION_ID,
      kind: "cloudflare_service_token",
      ciphertext: "enc:v1:svc",
    });
    expect(upserted.ok).toBe(true);
    if (upserted.ok) expect(upserted.value.credentialClass).toBe("infrastructure");
    expect(queries[0]!.params[3]).toBe("infrastructure");

    const identityUpsert = await repo.upsertProviderCredential({
      id: "00000000-0000-4000-8000-000000000011",
      connectionId: CONNECTION_ID,
      kind: "supabase_refresh_token",
      ciphertext: "enc:v1:rt",
    });
    expect(identityUpsert.ok).toBe(true);
    if (identityUpsert.ok) expect(identityUpsert.value.credentialClass).toBe("identity");
    expect(queries[1]!.params[3]).toBe("identity");
  });
});
