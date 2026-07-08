import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("640_event_lifecycle migration", () => {
  const entry = manifest.migrations.find((m) => m.id === "640_event_lifecycle");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";

  it("exists in manifest with context events, ordered after 630", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("events");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("640_event_lifecycle")).toBeGreaterThan(ids.indexOf("630_event_grouping"));
  });

  it("adds the storm-breaker columns idempotently", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS suppressed_at");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS suppressed_reason");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS saturated_window_count");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS last_saturated_at");
    expect(sql).toContain("DEFAULT 0");
  });

  it("adds the retention cutoff-scan partial indexes not already covered", () => {
    expect(sql).toContain("dead_letters_terminal_updated_idx");
    expect(sql).toContain("WHERE status IN ('replayed', 'discarded')");
    expect(sql).toContain("event_groups_closed_at_idx");
    expect(sql).toContain("WHERE status = 'closed'");
    expect(sql).toContain("notification_rules_suppressed_idx");
  });

  it("is additive, idempotent, and same-context", () => {
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/DROP COLUMN/);
    expect(sql).toContain("IF NOT EXISTS");
    expect(sql).not.toContain("REFERENCES membership.");
    expect(sql).not.toContain("REFERENCES webhooks.");
    expect(sql).not.toContain("REFERENCES notifications.");
  });
});
