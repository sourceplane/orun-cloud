// RS1 (provider-rotated-secrets): 'rotation' joins the mint-purpose enum so
// the mints that produce a rotated secret's stored value are ledgered
// distinctly from api / secret_resolve mints. Static SQL-shape assertions
// (no live Postgres), same style as the 820/880 migration tests.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("890_integrations_rotation_mint_purpose migration (RS1)", () => {
  const entry = manifest.migrations.find((m) => m.id === "890_integrations_rotation_mint_purpose");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";
  const executable = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("exists in manifest with context integrations, ordered after 880, checksum intact", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("integrations");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("890_integrations_rotation_mint_purpose")).toBeGreaterThan(
      ids.indexOf("880_config_rotated_secrets"),
    );
    expect(createHash("sha256").update(sql).digest("hex")).toBe(entry!.checksum);
  });

  it("swaps the purpose CHECK by name (the 720 lesson) and widens to rotation", () => {
    expect(executable).toContain("DROP CONSTRAINT IF EXISTS minted_credentials_purpose_check");
    expect(executable).toContain("ADD CONSTRAINT minted_credentials_purpose_check");
    expect(executable).toContain("CHECK (purpose IN ('api', 'secret_resolve', 'rotation'))");
  });

  it("is purely widening — every pre-existing purpose stays valid", () => {
    expect(executable).toContain("'api'");
    expect(executable).toContain("'secret_resolve'");
    expect(executable).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
