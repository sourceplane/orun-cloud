// RS0 (provider-rotated-secrets): the provider-rotation producer binding
// migration — rotation_* columns + guard CHECKs on config.secret_metadata so a
// stored `source = 'static'` secret can be rotated by the credential broker on
// the SM6 schedule. Static SQL-shape assertions only (no live Postgres), same
// style as the 820 brokered-secrets migration test.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("880_config_rotated_secrets migration (RS0)", () => {
  const entry = manifest.migrations.find((m) => m.id === "880_config_rotated_secrets");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";
  const executable = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("exists in manifest with context config, ordered after 860, checksum intact", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("config");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("880_config_rotated_secrets")).toBeGreaterThan(
      ids.indexOf("870_agents_profile_interface"),
    );
    expect(createHash("sha256").update(sql).digest("hex")).toBe(entry!.checksum);
  });

  it("adds the six rotation-producer columns", () => {
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS rotation_provider text");
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS rotation_connection_id uuid");
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS rotation_template text");
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS rotation_params jsonb");
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS rotation_grace_seconds integer");
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS rotation_deliver_target text");
  });

  it("guards the producer core as all-or-nothing", () => {
    expect(executable).toContain("secret_metadata_rotation_binding_guard_check");
    expect(executable).toContain(
      "(rotation_provider IS NOT NULL) = (rotation_connection_id IS NOT NULL AND rotation_template IS NOT NULL)",
    );
  });

  it("forces a provider-rotated secret to be static", () => {
    expect(executable).toContain("secret_metadata_rotation_static_check");
    expect(executable).toContain("rotation_provider IS NULL OR source = 'static'");
  });

  it("bounds grace seconds to non-negative", () => {
    expect(executable).toContain("secret_metadata_rotation_grace_check");
    expect(executable).toContain("rotation_grace_seconds IS NULL OR rotation_grace_seconds >= 0");
  });

  it("backs the engine scan with a partial org index", () => {
    expect(executable).toContain("secret_metadata_rotation_provider_idx");
    expect(executable).toContain("WHERE rotation_provider IS NOT NULL");
  });

  it("is additive and idempotent (guarded adds, no destructive DDL)", () => {
    expect(executable).toContain("ADD COLUMN IF NOT EXISTS");
    expect(executable).toContain("CREATE INDEX IF NOT EXISTS");
    expect(executable).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
