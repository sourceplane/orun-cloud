// IH2: the slack_app channel-kind migration + the event-group ↔ Slack
// message identity store.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { manifest } from "@saas/db";
import { createSlackGroupMessagesRepository } from "@saas/db/notifications";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("740_slack_app_channels migration", () => {
  const entry = manifest.migrations.find((m) => m.id === "740_slack_app_channels");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";

  it("exists in manifest with context notifications, ordered after 730, checksum intact", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("notifications");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("740_slack_app_channels")).toBeGreaterThan(
      ids.indexOf("730_integration_hub_foundation"),
    );
    expect(createHash("sha256").update(sql).digest("hex")).toBe(entry!.checksum);
  });

  it("widens the kind CHECK to both channel kinds, guarded", () => {
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS notification_channels_kind_check");
    expect(sql).toContain("CHECK (kind IN ('slack_incoming_webhook', 'slack_app'))");
  });

  it("creates the group-message identity table keyed by (channel, group)", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS notifications.slack_group_messages");
    expect(sql).toContain("PRIMARY KEY (channel_id, group_key)");
    expect(sql).toContain("ON DELETE CASCADE");
    // Coordinates only — no content column, no credential column (checked on
    // executable SQL; the header comments narrate custody rules).
    const executable = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executable).not.toMatch(/token|body|content|ciphertext/i);
  });
});

describe("slack group messages repository", () => {
  function fakeExecutor(respond: (text: string, params: unknown[]) => Record<string, unknown>[]): {
    executor: SqlExecutor;
    queries: Array<{ text: string; params: unknown[] }>;
  } {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const executor: SqlExecutor = {
      async execute<T extends SqlRow = SqlRow>(
        text: string,
        params?: unknown[],
      ): Promise<SqlExecutorResult<T>> {
        queries.push({ text, params: params ?? [] });
        const rows = respond(text, params ?? []) as unknown as T[];
        return { rows, rowCount: rows.length };
      },
    };
    return { executor, queries };
  }

  const ROW = {
    channel_id: "chan-uuid",
    group_key: "g1",
    slack_channel: "C0AAA",
    slack_ts: "1720000000.000001",
    last_severity: "notice",
    created_at: "2026-07-12T10:00:00Z",
    updated_at: "2026-07-12T10:00:00Z",
  };

  it("reads a story's coordinates (null when absent)", async () => {
    const { executor } = fakeExecutor((text) =>
      text.includes("SELECT") ? [ROW] : [],
    );
    const repo = createSlackGroupMessagesRepository(executor);
    const hit = await repo.get("chan-uuid", "g1");
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.value?.slackTs).toBe("1720000000.000001");

    const { executor: empty } = fakeExecutor(() => []);
    const miss = await createSlackGroupMessagesRepository(empty).get("chan-uuid", "g2");
    if (miss.ok) expect(miss.value).toBeNull();
  });

  it("upsert preserves the root ts by default and replaces it only on replaceTs", async () => {
    const { executor, queries } = fakeExecutor(() => [ROW]);
    const repo = createSlackGroupMessagesRepository(executor);
    await repo.upsert({
      channelId: "chan-uuid",
      groupKey: "g1",
      slackChannel: "C0AAA",
      slackTs: "1720999999.000009",
      lastSeverity: "error",
    });
    expect(queries[0]!.text).toContain("ON CONFLICT (channel_id, group_key) DO UPDATE");
    // $6 is the replaceTs switch: default false ⇒ the CASE keeps the old ts.
    expect(queries[0]!.params[5]).toBe(false);
    await repo.upsert({
      channelId: "chan-uuid",
      groupKey: "g1",
      slackChannel: "C0AAA",
      slackTs: "1720999999.000009",
      replaceTs: true,
    });
    expect(queries[1]!.params[5]).toBe(true);
  });
});
