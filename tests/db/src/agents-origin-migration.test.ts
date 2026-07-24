// 920_agents_origin migration (saas-agent-supervision SV0, design §2): the
// origin taint column, its inference backfill, and the roster-fold index.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("920_agents_origin migration", () => {
  const entry = manifest.migrations.find((m) => m.id === "920_agents_origin");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";

  it("exists in manifest with context agents, ordered after 910", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("agents");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("920_agents_origin")).toBeGreaterThan(ids.indexOf("910_integration_registry_rehome"));
  });

  it("adds the origin JSONB column NOT NULL with a human default", () => {
    expect(sql).toContain(
      `ADD COLUMN IF NOT EXISTS origin JSONB NOT NULL DEFAULT '{"kind":"human"}'::jsonb`,
    );
  });

  it("backfills legacy rows by inference, most-specific first, marked backfilled", () => {
    // Precedence: parent_session_id ⇒ session, routine_id ⇒ routine,
    // work_ref ⇒ work, else human.
    const parentIdx = sql.indexOf("parent_session_id IS NOT NULL");
    const routineIdx = sql.indexOf("routine_id IS NOT NULL");
    const workIdx = sql.indexOf("work_ref IS NOT NULL");
    expect(parentIdx).toBeGreaterThan(-1);
    expect(routineIdx).toBeGreaterThan(parentIdx);
    expect(workIdx).toBeGreaterThan(routineIdx);
    expect(sql).toContain("'kind', 'session'");
    expect(sql).toContain("'kind', 'routine'");
    expect(sql).toContain("'kind', 'work'");
    expect(sql).toContain("'kind', 'human'");
    expect(sql).toContain("'backfilled', true");
    // Only rewrites the bare default — never re-stamps a door-written origin.
    expect(sql).toContain(`WHERE origin = '{"kind":"human"}'::jsonb`);
  });

  it("adds the roster-fold expression index on (org_id, kind, ref)", () => {
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_agents_sessions_origin");
    expect(sql).toContain("(org_id, (origin->>'kind'), (origin->>'ref'))");
  });

  it("is additive, idempotent, same-context", () => {
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/DROP COLUMN/);
    expect(sql).toContain("IF NOT EXISTS");
    expect(sql).not.toContain("REFERENCES membership.");
    expect(sql).not.toContain("REFERENCES work.");
  });
});
