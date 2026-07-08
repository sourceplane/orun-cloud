import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("610_notification_channels migration", () => {
  const entry = manifest.migrations.find((m) => m.id === "610_notification_channels");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";

  it("exists in manifest with context notifications, ordered after 600", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("notifications");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("610_notification_channels")).toBeGreaterThan(
      ids.indexOf("600_notification_rule_throttle"),
    );
  });

  it("creates the channels table with an encrypted config column and kind/status CHECKs", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS notifications.notification_channels");
    expect(sql).toContain("config_ciphertext TEXT        NOT NULL");
    expect(sql).toContain("'slack_incoming_webhook'");
    expect(sql).toContain("CHECK (status IN ('active', 'disabled'))");
  });

  it("uniquely names channels per org (case-insensitive)", () => {
    expect(sql).toContain("notification_channels_org_name_idx");
    expect(sql).toContain("lower(name)");
  });

  it("lifts the channel CHECK to ('email','slack') on all three channel-bearing tables", () => {
    for (const constraint of [
      "notification_prefs_channel_check",
      "notifications_channel_check",
      "notification_suppressions_channel_check",
    ]) {
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS ${constraint}`);
      expect(sql).toContain(`ADD CONSTRAINT ${constraint}`);
    }
    expect(sql).toContain("CHECK (channel IN ('email', 'slack'))");
  });

  it("adds the async retry scaffolding to notifications", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0");
    expect(sql).toContain("notifications_retry_idx");
    expect(sql).toContain("WHERE status = 'failed' AND next_retry_at IS NOT NULL");
  });

  it("is idempotent (DROP CONSTRAINT IF EXISTS + ADD COLUMN IF NOT EXISTS + CREATE IF NOT EXISTS)", () => {
    expect(sql).not.toMatch(/DROP CONSTRAINT (?!IF EXISTS)/);
    expect(sql).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
  });

  it("adds no cross-context foreign keys", () => {
    expect(sql).not.toContain("REFERENCES events.");
    expect(sql).not.toContain("REFERENCES membership.");
    expect(sql).not.toContain("REFERENCES identity.");
  });
});
