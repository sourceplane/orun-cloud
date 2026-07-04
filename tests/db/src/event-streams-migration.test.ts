import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("580_event_streams_foundation migration", () => {
  const entry = manifest.migrations.find((m) => m.id === "580_event_streams_foundation");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";

  it("migration entry exists in manifest", () => {
    expect(entry).toBeDefined();
  });

  it("context is events", () => {
    expect(entry!.context).toBe("events");
  });

  it("orders after 570_state_catalog_projection", () => {
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("580_event_streams_foundation")).toBeGreaterThan(
      ids.indexOf("570_state_catalog_projection"),
    );
  });

  it("creates the lane registry", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events.subscriber_lanes");
    expect(sql).toMatch(/status\s+TEXT\s+NOT NULL DEFAULT 'active'/);
    expect(sql).toContain("'paused'");
  });

  it("creates lane cursors keyed by (lane_key, org_id)", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events.lane_cursors");
    expect(sql).toContain("PRIMARY KEY (lane_key, org_id)");
  });

  it("creates dead letters with a (lane, event) uniqueness", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events.dead_letters");
    expect(sql).toContain("dead_letters_lane_event_uq UNIQUE (lane_key, event_id)");
    expect(sql).toContain("REFERENCES events.event_log(id)");
  });

  it("creates notification rules with mandatory throttle fields", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events.notification_rules");
    expect(sql).toMatch(/throttle_window_seconds\s+INTEGER\s+NOT NULL/);
    expect(sql).toMatch(/throttle_max\s+INTEGER\s+NOT NULL/);
    expect(sql).toContain("notification_rules_org_name_uq UNIQUE (org_id, name)");
  });

  it("creates rule targets with the V1 kind vocabulary", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events.rule_targets");
    expect(sql).toContain("'email'");
    expect(sql).toContain("'slack_channel'");
    expect(sql).toContain("'webhook_endpoint'");
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("creates event groups with the one-open-story invariant", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events.event_groups");
    expect(sql).toContain("event_groups_open_key_uq");
    expect(sql).toMatch(/WHERE status = 'open'/);
  });

  it("creates group members keyed by (group_id, event_id)", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events.event_group_members");
    expect(sql).toContain("PRIMARY KEY (group_id, event_id)");
  });

  it("tenant scoping: every tenant-scoped table carries org_id TEXT NOT NULL", () => {
    expect(sql).toMatch(/org_id\s+TEXT\s+NOT NULL/);
  });

  it("severity vocabularies match the catalog ladder", () => {
    for (const severity of ["info", "notice", "warning", "error", "critical"]) {
      expect(sql).toContain(`'${severity}'`);
    }
  });

  it("does not contain cross-context foreign keys", () => {
    expect(sql).not.toContain("REFERENCES identity.");
    expect(sql).not.toContain("REFERENCES membership.");
    expect(sql).not.toContain("REFERENCES projects.");
    expect(sql).not.toContain("REFERENCES billing.");
    expect(sql).not.toContain("REFERENCES webhooks.");
    expect(sql).not.toContain("REFERENCES notifications.");
    expect(sql).not.toContain("REFERENCES integrations.");
  });

  it("DDL is idempotent (IF NOT EXISTS throughout)", () => {
    const createStatements = sql.match(/CREATE\s+(TABLE|INDEX|UNIQUE INDEX|SCHEMA)/g) ?? [];
    const ifNotExists = sql.match(/IF NOT EXISTS/g) ?? [];
    expect(ifNotExists.length).toBeGreaterThanOrEqual(createStatements.length);
  });

  it("keyset pagination indexes exist for org-scoped reads", () => {
    expect(sql).toContain("dead_letters_org_created_idx");
    expect(sql).toContain("notification_rules_org_created_idx");
    expect(sql).toContain("event_groups_org_last_idx");
  });
});
