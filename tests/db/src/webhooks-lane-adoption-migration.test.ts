import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("590_webhooks_lane_adoption migration", () => {
  const entry = manifest.migrations.find((m) => m.id === "590_webhooks_lane_adoption");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";

  it("migration entry exists in manifest with context events", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("events");
  });

  it("orders after the event streams foundation", () => {
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("590_webhooks_lane_adoption")).toBeGreaterThan(
      ids.indexOf("580_event_streams_foundation"),
    );
  });

  it("seeds the webhooks lane active", () => {
    expect(sql).toContain("'webhooks'");
    expect(sql).toContain("'active'");
  });

  it("seeds the notifications lane paused (dispatcher ships dark)", () => {
    expect(sql).toContain("'notifications'");
    expect(sql).toContain("'paused'");
  });

  it("backfills lane_cursors from the legacy webhooks cursor table", () => {
    expect(sql).toContain("INSERT INTO events.lane_cursors");
    expect(sql).toContain("FROM webhooks.webhook_dispatch_cursor");
    expect(sql).toContain("WHERE subscriber_lane = 'webhooks'");
  });

  it("is idempotent (ON CONFLICT DO NOTHING on both inserts)", () => {
    const inserts = sql.match(/INSERT INTO/g) ?? [];
    // Parenthesized conflict targets only — the prose header also mentions
    // the phrase, which must not count.
    const conflicts = sql.match(/ON CONFLICT \([^)]+\) DO NOTHING/g) ?? [];
    expect(inserts.length).toBe(2);
    expect(conflicts.length).toBe(2);
  });

  it("does not drop the legacy table (kept as dual-read fallback)", () => {
    expect(sql).not.toContain("DROP TABLE");
  });

  it("adds no cross-context foreign keys", () => {
    expect(sql).not.toContain("REFERENCES webhooks.");
    expect(sql).not.toContain("ADD CONSTRAINT");
  });
});
