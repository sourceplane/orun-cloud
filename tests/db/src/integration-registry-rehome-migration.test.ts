// IR5 (saas-integration-registry): the AI/compute re-home migration. Static
// SQL-shape assertions only (no live Postgres), same style as the 900 test.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("910_integration_registry_rehome migration (IR5)", () => {
  const entry = manifest.migrations.find((m) => m.id === "910_integration_registry_rehome");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";
  const executable = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("exists in manifest with context agents, ordered after 900, checksum intact", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("agents");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("910_integration_registry_rehome")).toBeGreaterThan(
      ids.indexOf("900_integrations_scope_templates"),
    );
    expect(createHash("sha256").update(sql).digest("hex")).toBe(entry!.checksum);
  });

  it("adds the connection_id pointer column + its index (the facts-table turn)", () => {
    expect(executable).toContain(
      "ALTER TABLE agents.provider_connections\n  ADD COLUMN IF NOT EXISTS connection_id UUID",
    );
    expect(executable).toContain("idx_agents_provider_connections_connection");
    expect(executable).toContain("COMMENT ON COLUMN agents.provider_connections.connection_id");
  });

  it("backfills one integrations.connections identity row per facts row via a single CTE pair", () => {
    expect(executable).toContain("WITH inserted AS (");
    expect(executable).toContain("INSERT INTO integrations.connections");
    expect(executable).toContain("gen_random_uuid()");
    // Status mapping: verified→active, invalid→suspended, unverified→pending.
    expect(executable).toContain("WHEN 'verified' THEN 'active'");
    expect(executable).toContain("WHEN 'invalid'  THEN 'suspended'");
    expect(executable).toContain("ELSE 'pending'");
    // connected_at carries last_verified_at for verified rows only.
    expect(executable).toContain("CASE WHEN pc.status = 'verified' THEN pc.last_verified_at END");
    // The UPDATE half stamps the pointer joining on the natural key.
    expect(executable).toContain("UPDATE agents.provider_connections pc");
    expect(executable).toContain("SET connection_id = i.id");
    expect(executable).toContain("pc.name     = i.display_name");
  });

  it("defaults re-homed tenancy to workspace-private + auto share (IR-D4)", () => {
    expect(executable).toContain("'workspace'");
    expect(executable).toContain("'auto'");
  });

  it("is idempotent (IF NOT EXISTS guards; backfill keys off connection_id IS NULL)", () => {
    expect(executable).toContain("IF NOT EXISTS");
    expect(executable).toContain("WHERE pc.connection_id IS NULL");
    // BOTH halves of the CTE pair are null-guarded so a re-run converges.
    expect(executable.match(/connection_id IS NULL/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("never touches custody: key material stays where it is", () => {
    // secret_ref appears only inside the COMMENT ON documentation string —
    // never as a written column.
    expect(executable).not.toMatch(/SET\s+secret_ref/i);
    expect(executable.toLowerCase()).not.toContain("api_key");
    expect(executable.toLowerCase()).not.toContain("ciphertext");
  });
});
