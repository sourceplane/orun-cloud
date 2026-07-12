import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, BOUNDED_CONTEXTS } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(
  __dirname,
  "../../..",
  "packages/db/src/migrations",
);

describe("Integrations Migration Verification", () => {
  const integrationsMigrations = manifest.migrations.filter(
    (m) => m.context === "integrations",
  );

  it("registers 'integrations' as a bounded context", () => {
    expect(BOUNDED_CONTEXTS).toContain("integrations");
  });

  it("has the 180_integrations_foundation migration", () => {
    expect(integrationsMigrations.map((m) => m.id)).toContain(
      "180_integrations_foundation",
    );
  });

  it("orders the integrations migrations consecutively (190 immediately after 180)", () => {
    const ids = manifest.migrations.map((m) => m.id);
    const i180 = ids.indexOf("180_integrations_foundation");
    expect(i180).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("190_integrations_delivery_attribution")).toBe(i180 + 1);
  });

  it("manifest checksums match the on-disk up.sql files", () => {
    for (const id of [
      "180_integrations_foundation",
      "190_integrations_delivery_attribution",
      "380_integrations_repo_single_claim",
      "390_integrations_connection_scope",
      "400_integrations_admission",
      "730_integration_hub_foundation",
    ]) {
      const entry = manifest.migrations.find((m) => m.id === id)!;
      const content = readFileSync(resolve(MIGRATIONS_ROOT, entry.path));
      const checksum = createHash("sha256").update(content).digest("hex");
      expect(entry.checksum).toBe(checksum);
    }
  });

  it("190 adds the connection pointer additively and idempotently", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "190_integrations_delivery_attribution/up.sql"),
      "utf-8",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS connection_id UUID");
    expect(sql).toContain("idx_integrations_inbound_deliveries_connection");
    expect(sql).toContain("WHERE connection_id IS NOT NULL");
  });

  it("380 adds the connection-scoped single-claim guard (IT2), additively", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "380_integrations_repo_single_claim/up.sql"),
      "utf-8",
    );
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_repo_claim");
    expect(sql).toMatch(/ON integrations\.repo_links \(connection_id, repo_external_id\)/);
    expect(sql).toContain("WHERE status = 'active'");
    // The existing per-project guard must NOT be dropped/altered here.
    expect(sql).not.toMatch(/DROP\s+INDEX/i);
  });

  it("390 adds connection.scope additively with a CHECK (IT7)", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "390_integrations_connection_scope/up.sql"),
      "utf-8",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'account'");
    expect(sql).toContain("chk_integrations_connections_scope");
    expect(sql).toMatch(/CHECK \(scope IN \('account', 'workspace'\)\)/);
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
  });

  it("730 lands the hub substrate (IH0): custody, ledger, provider facts — additively", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "730_integration_hub_foundation/up.sql"),
      "utf-8",
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS integrations.provider_credentials");
    expect(sql).toContain("uq_integrations_provider_credential_kind");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS integrations.minted_credentials");
    expect(sql).toContain("idx_integrations_minted_credentials_live");
    expect(sql).toMatch(/WHERE revoke_status = 'pending'/);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS integrations.slack_workspaces");
    // The Slack tenancy keystone: team_id globally unique (installation_id rule).
    expect(sql).toContain("uq_integrations_slack_workspace_team");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS integrations.cloudflare_accounts");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS integrations.supabase_orgs");
    // Custody rule: the ledger carries no credential value column.
    expect(sql).not.toMatch(/credential_value|token_plaintext/i);
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
  });

  it("400 adds share_mode + the connection_grants allow-list (IT8), additively", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "400_integrations_admission/up.sql"),
      "utf-8",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS share_mode TEXT NOT NULL DEFAULT 'auto'");
    expect(sql).toMatch(/CHECK \(share_mode IN \('auto', 'granted'\)\)/);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS integrations.connection_grants");
    expect(sql).toContain("uq_integrations_connection_grant_active");
    expect(sql).toMatch(/ON integrations\.connection_grants \(connection_id, org_id\)/);
    expect(sql).toContain("WHERE status = 'active'");
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
  });

  describe("integrations SQL schema validation", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "180_integrations_foundation/up.sql"),
      "utf-8",
    );

    it("creates the integrations schema", () => {
      expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS integrations");
    });

    it("creates the five foundation tables", () => {
      expect(sql).toContain("integrations.connections");
      expect(sql).toContain("integrations.github_installations");
      expect(sql).toContain("integrations.repo_links");
      expect(sql).toContain("integrations.inbound_deliveries");
      expect(sql).toContain("integrations.installation_tokens");
    });

    it("is idempotent (IF NOT EXISTS on every CREATE)", () => {
      const creates = sql.match(/^CREATE (TABLE|SCHEMA|INDEX|UNIQUE INDEX)/gm) ?? [];
      const guarded = sql.match(/^CREATE (?:TABLE|SCHEMA|INDEX|UNIQUE INDEX) IF NOT EXISTS/gm) ?? [];
      expect(creates.length).toBeGreaterThan(0);
      expect(guarded.length).toBe(creates.length);
    });

    it("enforces the delivery idempotency ledger (unique provider + delivery_key)", () => {
      expect(sql).toContain("uq_integrations_inbound_delivery_key");
      expect(sql).toMatch(/ON integrations\.inbound_deliveries \(provider, delivery_key\)/);
    });

    it("enforces one active connection per (org, provider, account)", () => {
      expect(sql).toContain("uq_integrations_connection_active_account");
      expect(sql).toMatch(/WHERE status = 'active' AND external_account_id IS NOT NULL/);
    });

    it("enforces one active repo link per (project, repo)", () => {
      expect(sql).toContain("uq_integrations_repo_link_project_repo");
    });

    it("keeps the installation binding unique (tenancy keystone)", () => {
      expect(sql).toContain("uq_integrations_github_installation");
    });

    it("has keyset pagination indexes on org-scoped tables", () => {
      expect(sql).toMatch(/ON integrations\.connections \(org_id, created_at DESC, id DESC\)/);
      expect(sql).toMatch(/ON integrations\.repo_links \(org_id, created_at DESC, id DESC\)/);
      expect(sql).toMatch(/ON integrations\.inbound_deliveries \(org_id, received_at DESC, id DESC\)/);
    });

    it("never stores platform GitHub credentials as rows", () => {
      // Cached installation tokens are ciphertext envelopes; the App private
      // key / webhook secret / client secret must not have columns.
      expect(sql).not.toMatch(/private_key/i);
      expect(sql).not.toMatch(/webhook_secret/i);
      expect(sql).not.toMatch(/client_secret/i);
      expect(sql).toContain("token_ciphertext");
    });
  });
});
