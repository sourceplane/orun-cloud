// IH7: the brokered-secret metadata discriminator migration — source +
// display-only binding facts on config.secret_metadata. The binding POINTER
// rides the existing version envelope; this only adds what list/chain reads
// need to render broker provenance.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("820_config_brokered_secrets migration (IH7)", () => {
  const entry = manifest.migrations.find((m) => m.id === "820_config_brokered_secrets");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";
  // Assertions on SQL shape run against executable lines only — the header
  // comments narrate the design and would otherwise trip content regexes.
  const executable = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("exists in manifest with context config, ordered after 810, checksum intact", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("config");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("820_config_brokered_secrets")).toBeGreaterThan(
      ids.indexOf("810_supabase_oauth"),
    );
    expect(createHash("sha256").update(sql).digest("hex")).toBe(entry!.checksum);
  });

  it("adds the source discriminator and the three display-only binding facts", () => {
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'static'");
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS binding_provider text");
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS binding_connection_id uuid");
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS binding_template text");
  });

  it("adds the named guard constraints (no auto-named inline CHECKs)", () => {
    // source is a closed enum.
    expect(executable).toContain("ADD CONSTRAINT secret_metadata_source_check");
    expect(executable).toContain("CHECK (source IN ('static', 'brokered'))");
    // Binding facts are all-or-nothing WITH the discriminator.
    expect(executable).toContain("ADD CONSTRAINT secret_metadata_binding_guard_check");
    expect(executable).toContain(
      "CHECK ((source = 'brokered') = (binding_provider IS NOT NULL AND binding_connection_id IS NOT NULL AND binding_template IS NOT NULL))",
    );
    // A personal overlay can never be brokered.
    expect(executable).toContain("ADD CONSTRAINT secret_metadata_brokered_personal_check");
    expect(executable).toContain("CHECK (source = 'static' OR personal_owner IS NULL)");
  });

  it("adds the partial org index backing the entitlement count", () => {
    expect(executable).toContain("CREATE INDEX IF NOT EXISTS secret_metadata_brokered_org_idx");
    expect(executable).toContain("ON config.secret_metadata (org_id)");
    expect(executable).toContain("WHERE source = 'brokered'");
  });

  it("is idempotent (guarded DO-blocks / IF [NOT] EXISTS)", () => {
    expect(executable).toContain("pg_constraint");
    expect(executable).toContain("IF NOT EXISTS");
  });

  it("touches metadata only — no value-bearing column is added", () => {
    // The binding pointer stays in the version envelope; this migration adds
    // exactly the discriminator + the three display facts and nothing that
    // could carry a value. (COMMENT ON literals narrate the envelope design,
    // so the check keys off the ADD COLUMN set, not raw text.)
    const added = [...executable.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect([...added].sort()).toEqual([
      "binding_connection_id",
      "binding_provider",
      "binding_template",
      "source",
    ]);
    expect(executable).not.toMatch(/plaintext|secret_value/i);
  });
});
