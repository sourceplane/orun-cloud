import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("600_notification_rule_throttle migration", () => {
  const entry = manifest.migrations.find((m) => m.id === "600_notification_rule_throttle");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";

  it("exists in manifest with context events, ordered after 590", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("events");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("600_notification_rule_throttle")).toBeGreaterThan(
      ids.indexOf("590_webhooks_lane_adoption"),
    );
  });

  it("creates the throttle ledger keyed by rule with cascade", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events.rule_throttle_state");
    expect(sql).toContain("REFERENCES events.notification_rules(id) ON DELETE CASCADE");
    expect(sql).toMatch(/window_started_at\s+TIMESTAMPTZ\s+NOT NULL/);
    expect(sql).toMatch(/fired_count\s+INTEGER\s+NOT NULL/);
  });

  it("activates only the seeded-paused notifications lane", () => {
    expect(sql).toContain("SET status = 'active'");
    expect(sql).toContain("WHERE lane_key = 'notifications' AND status = 'paused'");
  });

  it("adds no cross-context references", () => {
    expect(sql).not.toContain("REFERENCES webhooks.");
    expect(sql).not.toContain("REFERENCES notifications.");
  });
});
