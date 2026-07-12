// IH0: the integration-hub repository (custody, mint ledger, provider facts)
// against the fake-executor harness — SQL shape + mapping + fail-safe rules.

import { createIntegrationHubRepository } from "@saas/db/integrations";
import { asUuid } from "@saas/db";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG_ID = asUuid("00000000-0000-4000-8000-000000000001");
const CONNECTION_ID = asUuid("00000000-0000-4000-8000-000000000002");
const MINT_ID = asUuid("00000000-0000-4000-8000-000000000003");

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  error?: unknown;
  rowCount?: number;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      if (options?.error) throw options.error;
      const rows = (options?.rows ?? []) as unknown as T[];
      return { rows, rowCount: options?.rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-07-09T10:00:00Z");

const CREDENTIAL_ROW = {
  id: "00000000-0000-4000-8000-000000000010",
  connection_id: CONNECTION_ID,
  kind: "cloudflare_parent_token",
  ciphertext: "enc:v1:abc",
  scopes: JSON.stringify({ policies: ["workers"] }),
  external_ref: "cf-token-id",
  expires_at: null,
  rotated_at: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const MINT_ROW = {
  id: MINT_ID,
  org_id: ORG_ID,
  connection_id: CONNECTION_ID,
  provider: "cloudflare",
  template: "workers-deploy",
  params: JSON.stringify({}),
  purpose: "api",
  requested_by: "usr_abc",
  run_id: null,
  job_id: null,
  ttl_seconds: 900,
  provider_ref: "cf-child-token",
  minted_at: NOW.toISOString(),
  expires_at: new Date(NOW.getTime() + 900_000).toISOString(),
  revoked_at: null,
  revoke_status: "pending",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

describe("integration-hub repository (IH0)", () => {
  describe("provider credentials (custody)", () => {
    it("upserts by (connection, kind) and rotates in place", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [CREDENTIAL_ROW] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.upsertProviderCredential({
        id: "00000000-0000-4000-8000-000000000010",
        connectionId: CONNECTION_ID,
        kind: "cloudflare_parent_token",
        ciphertext: "enc:v1:abc",
        scopes: { policies: ["workers"] },
        externalRef: "cf-token-id",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kind).toBe("cloudflare_parent_token");
        expect(result.value.ciphertext).toBe("enc:v1:abc");
      }
      expect(queries[0]!.text).toContain("ON CONFLICT (connection_id, kind)");
      expect(queries[0]!.text).toContain("rotated_at = now()");
    });

    it("reads a credential back for the worker to decrypt", async () => {
      const { executor } = createFakeExecutor({ rows: [CREDENTIAL_ROW] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.getProviderCredential(CONNECTION_ID, "cloudflare_parent_token");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.externalRef).toBe("cf-token-id");
    });

    it("misses with not_found, never a throw", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.getProviderCredential(CONNECTION_ID, "slack_bot_token");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });

    it("zeroizes every custody row for a connection on revoke", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [], rowCount: 2 });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.deleteProviderCredentials(CONNECTION_ID);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.deleted).toBe(2);
      expect(queries[0]!.text).toContain("DELETE FROM integrations.provider_credentials");
    });

    it("fails safe on executor errors", async () => {
      const { executor } = createFakeExecutor({ error: new Error("boom") });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.getProviderCredential(CONNECTION_ID, "slack_bot_token");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("internal");
    });
  });

  describe("minted-credential ledger", () => {
    it("inserts a ledger row without any credential value column", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [MINT_ROW] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.insertMintedCredential({
        id: MINT_ID,
        orgId: ORG_ID,
        connectionId: CONNECTION_ID,
        provider: "cloudflare",
        template: "workers-deploy",
        purpose: "api",
        requestedBy: "usr_abc",
        ttlSeconds: 900,
        providerRef: "cf-child-token",
        expiresAt: new Date(NOW.getTime() + 900_000),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.template).toBe("workers-deploy");
        expect(result.value.revokeStatus).toBe("pending");
      }
      // The ledger schema carries no value column — assert the insert never
      // mentions one (custody rule: metadata only).
      expect(queries[0]!.text).not.toMatch(/token|credential_value|ciphertext/i);
    });

    it("lists the org ledger keyset-paginated with filters", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [MINT_ROW] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.listMintedCredentials(
        ORG_ID,
        { limit: 20, cursor: null },
        { connectionId: CONNECTION_ID, purpose: "api" },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(1);
        expect(result.value.nextCursor).toBeNull();
      }
      expect(queries[0]!.text).toContain("ORDER BY created_at DESC, id DESC");
      expect(queries[0]!.params).toEqual([ORG_ID, CONNECTION_ID, "api", 21]);
    });

    it("marks revocation status", async () => {
      const revoked = { ...MINT_ROW, revoke_status: "revoked", revoked_at: NOW.toISOString() };
      const { executor } = createFakeExecutor({ rows: [revoked] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.markMintedCredential(MINT_ID, {
        revokeStatus: "revoked",
        revokedAt: NOW,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.revokeStatus).toBe("revoked");
    });

    it("scans live mints per connection for the revoke fan-out", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [MINT_ROW] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.listLiveMintedCredentials(CONNECTION_ID);
      expect(result.ok).toBe(true);
      expect(queries[0]!.text).toContain("revoke_status = 'pending'");
    });

    it("counts mints since a cutoff (rate limiting)", async () => {
      const { executor } = createFakeExecutor({ rows: [{ count: 7 }] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.countMintedCredentialsSince(ORG_ID, NOW);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(7);
    });
  });

  describe("provider facts", () => {
    it("upserts slack workspaces keyed by the team_id keystone", async () => {
      const row = {
        id: "00000000-0000-4000-8000-000000000020",
        connection_id: CONNECTION_ID,
        team_id: "T012AB3CD",
        team_name: "Acme",
        enterprise_id: null,
        bot_user_id: "U0BOT",
        app_id: "A0APP",
        granted_scopes: JSON.stringify(["chat:write"]),
        installed_by_external_user: "U0ADMIN",
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      };
      const { executor, queries } = createFakeExecutor({ rows: [row] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.upsertSlackWorkspace({
        id: "00000000-0000-4000-8000-000000000020",
        connectionId: CONNECTION_ID,
        teamId: "T012AB3CD",
        teamName: "Acme",
        botUserId: "U0BOT",
        appId: "A0APP",
        grantedScopes: ["chat:write"],
        installedByExternalUser: "U0ADMIN",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.teamId).toBe("T012AB3CD");
      expect(queries[0]!.text).toContain("ON CONFLICT (team_id)");
    });

    it("upserts cloudflare accounts with the verified grant", async () => {
      const row = {
        id: "00000000-0000-4000-8000-000000000030",
        connection_id: CONNECTION_ID,
        account_external_id: "cf-acct-1",
        account_name: "Acme",
        parent_token_ref: "tok-1",
        granted_policies: JSON.stringify([{ id: "p1" }]),
        token_status: "active",
        parent_expires_at: null,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      };
      const { executor } = createFakeExecutor({ rows: [row] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.upsertCloudflareAccount({
        id: "00000000-0000-4000-8000-000000000030",
        connectionId: CONNECTION_ID,
        accountExternalId: "cf-acct-1",
        accountName: "Acme",
        parentTokenRef: "tok-1",
        grantedPolicies: [{ id: "p1" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tokenStatus).toBe("active");
        expect(result.value.grantedPolicies).toEqual([{ id: "p1" }]);
      }
    });

    it("upserts supabase orgs with cached project refs", async () => {
      const row = {
        id: "00000000-0000-4000-8000-000000000040",
        connection_id: CONNECTION_ID,
        supabase_org_id: "sb-org-1",
        org_name: "Acme",
        granted_scopes: null,
        projects: JSON.stringify([{ ref: "abcd1234" }]),
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      };
      const { executor } = createFakeExecutor({ rows: [row] });
      const repo = createIntegrationHubRepository(executor);
      const result = await repo.upsertSupabaseOrg({
        id: "00000000-0000-4000-8000-000000000040",
        connectionId: CONNECTION_ID,
        supabaseOrgId: "sb-org-1",
        orgName: "Acme",
        projects: [{ ref: "abcd1234" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.projects).toEqual([{ ref: "abcd1234" }]);
    });
  });
});
