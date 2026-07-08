import { createWebhookRepository } from "@saas/db/webhooks";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

// ES1 cutover coverage: the webhooks dispatch cursor now lives on the shared
// events.lane_cursors table, with a read-through fallback to the legacy
// webhooks.webhook_dispatch_cursor row (R6 protocol) and writes going to the
// shared table only.

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(
  callResponses: Array<{ rows?: Record<string, unknown>[]; rowCount?: number; error?: unknown }>,
): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  let callIndex = 0;
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const response = callResponses[Math.min(callIndex, callResponses.length - 1)] ?? {};
      callIndex++;
      if (response.error) throw response.error;
      const rows = (response.rows ?? []) as unknown as T[];
      return { rows, rowCount: response.rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const NOW = "2026-07-04T10:00:00.000Z";

const SHARED_ROW = {
  lane_key: "webhooks",
  org_id: "org-001",
  last_event_id: "evt-100",
  last_occurred_at: NOW,
  updated_at: NOW,
};

const LEGACY_ROW = {
  org_id: "org-001",
  subscriber_lane: "webhooks",
  last_event_id: "evt-050",
  last_occurred_at: NOW,
  updated_at: NOW,
};

describe("webhooks dispatch cursor (shared lane table cutover)", () => {
  it("reads the shared events.lane_cursors table first", async () => {
    const { executor, queries } = createFakeExecutor([{ rows: [SHARED_ROW] }]);
    const repo = createWebhookRepository(executor);
    const result = await repo.getDispatchCursor("org-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lastEventId).toBe("evt-100");
      expect(result.value.subscriberLane).toBe("webhooks");
    }
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("FROM events.lane_cursors");
    expect(queries[0]!.params).toEqual(["org-001", "webhooks"]);
  });

  it("falls back to the legacy table when the shared row is absent", async () => {
    const { executor, queries } = createFakeExecutor([{ rows: [] }, { rows: [LEGACY_ROW] }]);
    const repo = createWebhookRepository(executor);
    const result = await repo.getDispatchCursor("org-001");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.lastEventId).toBe("evt-050");
    expect(queries).toHaveLength(2);
    expect(queries[1]!.text).toContain("FROM webhooks.webhook_dispatch_cursor");
  });

  it("returns the zero cursor when neither table has a row", async () => {
    const { executor } = createFakeExecutor([{ rows: [] }, { rows: [] }]);
    const repo = createWebhookRepository(executor);
    const result = await repo.getDispatchCursor("org-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lastEventId).toBeNull();
      expect(result.value.lastOccurredAt).toBeNull();
      expect(result.value.updatedAt.getTime()).toBe(0);
    }
  });

  it("advances the cursor on the shared table only", async () => {
    const { executor, queries } = createFakeExecutor([{ rows: [SHARED_ROW] }]);
    const repo = createWebhookRepository(executor);
    const result = await repo.advanceDispatchCursor("org-001", "evt-100", NOW);
    expect(result.ok).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("INSERT INTO events.lane_cursors");
    expect(queries[0]!.text).toContain("ON CONFLICT (lane_key, org_id)");
    expect(queries[0]!.text).not.toContain("webhook_dispatch_cursor");
    expect(queries[0]!.params).toEqual(["org-001", "webhooks", "evt-100", NOW]);
  });
});
