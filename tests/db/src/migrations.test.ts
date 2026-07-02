import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, BOUNDED_CONTEXTS } from "@saas/db";
import type { BoundedContext, MigrationEntry } from "@saas/db";
// @ts-expect-error — plain .mjs generator, no types
import { renderLock, migrationIds } from "../../../packages/db/scripts/gen-migrations-lock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(
  __dirname,
  "../../..",
  "packages/db/src/migrations"
);

function computeChecksum(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

describe("Migration Manifest Verifier", () => {
  const { migrations } = manifest;

  it("manifest has version 1", () => {
    expect(manifest.version).toBe(1);
  });

  it("has at least one migration", () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  describe("ID uniqueness and ordering", () => {
    it("all migration IDs are unique", () => {
      const ids = migrations.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("migration IDs are sorted in ascending lexicographic order", () => {
      const ids = migrations.map((m) => m.id);
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });

    it("migration IDs follow the naming convention", () => {
      const pattern = /^\d{3}_[a-z]+_[a-z][a-z0-9_]*$/;
      for (const m of migrations) {
        expect(m.id).toMatch(pattern);
      }
    });
  });

  describe("bounded context ownership", () => {
    const VALID_CONTEXTS = BOUNDED_CONTEXTS;

    it("each migration declares a valid bounded context", () => {
      for (const m of migrations) {
        expect(VALID_CONTEXTS).toContain(m.context);
      }
    });
  });

  describe("file existence and manifest completeness", () => {
    it("each migration file exists on disk", () => {
      for (const m of migrations) {
        const fullPath = resolve(MIGRATIONS_ROOT, m.path);
        expect(existsSync(fullPath)).toBe(true);
      }
    });
  });

  describe("checksum integrity (drift detection)", () => {
    it.each(migrations.map((m) => [m.id, m] as [string, MigrationEntry]))(
      "checksum matches for %s",
      (_id, m) => {
        const fullPath = resolve(MIGRATIONS_ROOT, m.path);
        const actual = computeChecksum(fullPath);
        expect(actual).toBe(m.checksum);
      }
    );
  });

  describe("tenant isolation invariant", () => {
    it("project-scoped migrations reference org_id + project_id pattern", () => {
      const PROJECT_SCOPED_CONTEXTS: BoundedContext[] = ["projects"];

      const projectMigrations = migrations.filter((m) =>
        PROJECT_SCOPED_CONTEXTS.includes(m.context)
      );

      for (const m of projectMigrations) {
        const fullPath = resolve(MIGRATIONS_ROOT, m.path);
        const sql = readFileSync(fullPath, "utf-8");
        expect(sql).toContain("org_id");
        expect(sql).toContain("project_id");
      }

      expect(true).toBe(true);
    });

    it("project-scoped migrations do not reference other bounded-context schemas", () => {
      const PROJECT_SCOPED_CONTEXTS: BoundedContext[] = ["projects"];
      const FORBIDDEN_REFS = ["membership.", "identity.", "billing.", "events."];

      const projectMigrations = migrations.filter((m) =>
        PROJECT_SCOPED_CONTEXTS.includes(m.context)
      );

      for (const m of projectMigrations) {
        const fullPath = resolve(MIGRATIONS_ROOT, m.path);
        const sql = readFileSync(fullPath, "utf-8");
        for (const ref of FORBIDDEN_REFS) {
          expect(sql).not.toContain(ref);
        }
      }
    });
  });

  // saas-workspace-id WID7 — the account-scope + overridable guardrail migration.
  describe("430_config_account_scope (WID7)", () => {
    const entry = manifest.migrations.find((m) => m.id === "430_config_account_scope");

    it("is registered in the manifest under the config context", () => {
      expect(entry).toBeDefined();
      expect(entry!.context).toBe("config");
    });

    it("adds the overridable column, account scope_kind, and the guardrail CHECK", () => {
      const sql = readFileSync(resolve(MIGRATIONS_ROOT, entry!.path), "utf-8");
      expect(sql).toContain("ADD COLUMN IF NOT EXISTS overridable BOOLEAN NOT NULL DEFAULT true");
      expect(sql).toContain("scope_kind IN ('organization', 'project', 'environment', 'account')");
      expect(sql).toContain("CHECK (overridable = true OR scope_kind = 'account')");
    });

    it("is idempotent (guarded DO-blocks / IF [NOT] EXISTS)", () => {
      const sql = readFileSync(resolve(MIGRATIONS_ROOT, entry!.path), "utf-8");
      expect(sql).toContain("DROP CONSTRAINT settings_scope_kind_check");
      expect(sql).toContain("pg_constraint");
      // Replacing the CHECK is guarded so re-running is a no-op.
      expect(sql).toContain("IF NOT EXISTS");
    });
  });

  // saas-secret-manager SM1 — the secret store v3 migration.
  describe("470_config_secret_manager (SM1)", () => {
    const entry = manifest.migrations.find((m) => m.id === "470_config_secret_manager");

    it("is registered in the manifest under the config context", () => {
      expect(entry).toBeDefined();
      expect(entry!.context).toBe("config");
    });

    it("creates the append-only secret_versions table with backfill", () => {
      const sql = readFileSync(resolve(MIGRATIONS_ROOT, entry!.path), "utf-8");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS config.secret_versions");
      expect(sql).toContain("PRIMARY KEY (secret_id, version)");
      expect(sql).toContain("CHECK (version >= 1)");
      expect(sql).toContain("CHECK (status IN ('active', 'revoked'))");
      // Backfill copies each live envelope as its current version, idempotently.
      expect(sql).toContain("WHERE ciphertext_envelope IS NOT NULL");
      expect(sql).toContain("ON CONFLICT (secret_id, version) DO NOTHING");
    });

    it("widens secret_metadata with the chain columns and guardrail CHECKs", () => {
      const sql = readFileSync(resolve(MIGRATIONS_ROOT, entry!.path), "utf-8");
      expect(sql).toContain("ADD COLUMN IF NOT EXISTS personal_owner UUID");
      expect(sql).toContain("ADD COLUMN IF NOT EXISTS overridable BOOLEAN NOT NULL DEFAULT true");
      expect(sql).toContain("ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ");
      expect(sql).toContain("scope_kind IN ('organization', 'project', 'environment', 'account')");
      // Secrets may be locked at account OR organization scope (unlike settings).
      expect(sql).toContain("CHECK (overridable = true OR scope_kind IN ('account', 'organization'))");
      // Personal overlays are environment-scope only.
      expect(sql).toContain("CHECK (personal_owner IS NULL OR scope_kind = 'environment')");
      // The scope-key unique index keys per personal owner.
      expect(sql).toContain("COALESCE(personal_owner, '00000000-0000-0000-0000-000000000000')");
    });

    it("is idempotent (guarded DO-blocks / IF [NOT] EXISTS)", () => {
      const sql = readFileSync(resolve(MIGRATIONS_ROOT, entry!.path), "utf-8");
      expect(sql).toContain("DROP CONSTRAINT secret_metadata_scope_kind_check");
      expect(sql).toContain("pg_constraint");
      expect(sql).toContain("IF NOT EXISTS");
    });
  });

  describe("migration description", () => {
    it("each migration has a non-empty description", () => {
      for (const m of migrations) {
        expect(m.description.length).toBeGreaterThan(0);
      }
    });
  });

  // infra/db-migrate/migrations.lock is the change-detection stamp that makes
  // orun's --changed planner schedule the db-migrate component when a migration
  // is added (it keys off infra/db-migrate/, not packages/db/). If this drifts,
  // a new migration would silently never reach the live database.
  describe("db-migrate change-detection lock", () => {
    const LOCK_PATH = resolve(__dirname, "../../..", "infra/db-migrate/migrations.lock");

    it("infra/db-migrate/migrations.lock is in sync (run: pnpm --filter @saas/db gen:migrations-lock)", () => {
      expect(existsSync(LOCK_PATH)).toBe(true);
      expect(readFileSync(LOCK_PATH, "utf-8")).toBe(renderLock());
    });

    it("the lock covers exactly the manifest's migration ids", () => {
      const manifestIds = manifest.migrations.map((m) => m.id).sort();
      expect(migrationIds()).toEqual(manifestIds);
    });
  });
});
