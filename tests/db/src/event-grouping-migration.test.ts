import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("630_event_grouping migration", () => {
  const entry = manifest.migrations.find((m) => m.id === "630_event_grouping");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";

  it("exists in manifest with context events, ordered after 610", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("events");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("630_event_grouping")).toBeGreaterThan(ids.indexOf("610_notification_channels"));
  });

  it("seeds the grouping lane active", () => {
    expect(sql).toContain("INTO events.subscriber_lanes");
    expect(sql).toContain("'grouping'");
    expect(sql).toContain("'active'");
    expect(sql).toContain("ON CONFLICT (lane_key) DO NOTHING");
  });

  it("creates the group-notification ledger keyed by (rule_id, group_key) with cascade", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events.rule_group_notifications");
    expect(sql).toContain("REFERENCES events.notification_rules(id) ON DELETE CASCADE");
    expect(sql).toContain("PRIMARY KEY (rule_id, group_key)");
    expect(sql).toContain("max_notified_severity");
  });

  it("is idempotent and same-context", () => {
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toContain("REFERENCES membership.");
    expect(sql).not.toContain("REFERENCES webhooks.");
  });
});
