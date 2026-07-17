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
import { handleGetIntegration } from "@integrations-worker/handlers/connections";
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

// ── SI6: metadata-only custody summary on the connection detail ──

describe("GET …/integrations/{id} custody summary (SI6)", () => {
  const ORG_UUID = "11111111-1111-4111-8111-111111111111";
  const jsonFetcher = (body: unknown) =>
    ({
      fetch: () => Promise.resolve(Response.json(body)),
      connect() {
        throw new Error("not implemented");
      },
    }) as unknown as Fetcher;
  const env = {
    SECRET_ENCRYPTION_KEY: KEY,
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [
          { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } },
        ],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
  } as unknown as Env;
  const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

  it("projects custody metadata (class, user-tie, rotation) — never ciphertext, filtering transient kinds", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) {
        return [{
          id: CONNECTION_UUID, org_id: ORG_UUID, provider: "cloudflare", status: "active",
          scope: "account", share_mode: "auto", display_name: "CF", created_by: "usr_abc",
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        }];
      }
      if (text.includes("FROM integrations.provider_credentials")) {
        // The summary SELECT never asks for ciphertext.
        expect(text).not.toContain("ciphertext");
        return [
          {
            id: "c1", connection_id: CONNECTION_UUID, kind: "cloudflare_service_token",
            credential_class: "infrastructure", scopes: JSON.stringify(["Workers Scripts Write"]),
            external_ref: "acc-1", rotated_at: NOW.toISOString(), created_at: NOW.toISOString(),
            updated_at: NOW.toISOString(),
          },
          {
            id: "c2", connection_id: CONNECTION_UUID, kind: "cloudflare_refresh_token",
            credential_class: "identity", scopes: null, external_ref: "acc-1",
            rotated_at: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
          },
          {
            id: "c3", connection_id: CONNECTION_UUID, kind: "cloudflare_pkce_verifier",
            credential_class: "identity", scopes: null, external_ref: null,
            rotated_at: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
          },
        ];
      }
      return [];
    });
    const res = await handleGetIntegration(
      env, "req_1", ACTOR, asUuid(ORG_UUID), CONNECTION_ID, { executor },
    );
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { custody?: Array<Record<string, unknown>> } }).data;
    expect(data.custody).toHaveLength(2); // the PKCE verifier never surfaces
    const [service, refresh] = data.custody!;
    expect(service).toMatchObject({
      kind: "cloudflare_service_token",
      credentialClass: "infrastructure",
      userDerived: false,
    });
    expect(typeof service!.rotatedAt).toBe("string");
    expect(refresh).toMatchObject({
      kind: "cloudflare_refresh_token",
      credentialClass: "identity",
      userDerived: true,
      rotatedAt: null,
    });
    // The payload carries no secret material fields at all.
    expect(JSON.stringify(data)).not.toContain("ciphertext");
  });
});
