// SP4 (saas-secrets-platform): the org-curated scope-template store. Static
// SQL-shape assertions only (no live Postgres), same style as the 880 test.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("900_integrations_scope_templates migration (SP4)", () => {
  const entry = manifest.migrations.find((m) => m.id === "900_integrations_scope_templates");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";
  const executable = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("exists in manifest with context integrations, ordered after 890, checksum intact", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("integrations");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("900_integrations_scope_templates")).toBeGreaterThan(
      ids.indexOf("890_integrations_rotation_mint_purpose"),
    );
    expect(createHash("sha256").update(sql).digest("hex")).toBe(entry!.checksum);
  });

  it("creates the table with identity, base derivation, version, and status", () => {
    expect(executable).toContain("CREATE TABLE IF NOT EXISTS integrations.scope_templates");
    for (const col of ["org_id", "provider", "template_id", "base_template", "display_name", "version", "status"]) {
      expect(executable).toContain(col);
    }
    expect(executable).toContain("CHECK (status IN ('active', 'retired'))");
  });

  it("enforces one template id per (org, provider) and indexes the serve path", () => {
    expect(executable).toContain("uq_integrations_scope_templates_identity");
    expect(executable).toContain("(org_id, provider, template_id)");
    expect(executable).toContain("ix_integrations_scope_templates_org_provider");
  });

  it("is idempotent (IF NOT EXISTS + guarded CHECK swap)", () => {
    expect(executable).toContain("IF NOT EXISTS");
    expect(executable).toContain("DROP CONSTRAINT IF EXISTS scope_templates_status_check");
  });
});
