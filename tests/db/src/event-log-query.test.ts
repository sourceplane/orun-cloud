import { createEventsRepository } from "@saas/db/events";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  error?: unknown;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      if (options?.error) throw options.error;
      const rows = (options?.rows ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-07-05T10:00:00.000Z");
const ORG = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function eventRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "evt_0123456789abcdef0123456789abcdef",
    type: "custom.order.placed",
    version: 1,
    source: "custom-ingest",
    occurred_at: NOW.toISOString(),
    actor_type: "user",
    actor_id: "usr_1",
    actor_session_id: null,
    actor_ip: null,
    org_id: ORG,
    project_id: null,
    environment_id: null,
    subject_kind: "custom",
    subject_id: "custom",
    subject_name: null,
    request_id: "req_1",
    correlation_id: null,
    causation_id: null,
    idempotency_key: null,
    payload: JSON.stringify({ region: "us" }),
    redact_paths: JSON.stringify([]),
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

describe("events repository: queryEventLogByOrg", () => {
  it("reads events.event_log ordered by keyset and maps rows to StoredEvent", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [eventRow()] });
    const repo = createEventsRepository(executor);

    const result = await repo.queryEventLogByOrg(ORG, { limit: 50, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.items[0]!.type).toBe("custom.order.placed");
      expect(result.value.items[0]!.payload).toEqual({ region: "us" });
      expect(result.value.nextCursor).toBeNull();
    }
    expect(queries[0]!.text).toContain("FROM events.event_log");
    expect(queries[0]!.text).toContain("ORDER BY occurred_at DESC, id DESC");
    // org id is $1, limit is the last positional param
    expect(queries[0]!.params[0]).toBe(ORG);
    expect(queries[0]!.params[queries[0]!.params.length - 1]).toBe(51);
  });

  it("builds a LIKE clause for a trailing-* type glob and escapes metacharacters", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);
    await repo.queryEventLogByOrg(ORG, { limit: 10, cursor: null }, { type: "custom.*" });
    expect(queries[0]!.text).toContain("type LIKE");
    expect(queries[0]!.params).toContain("custom.%");
  });

  it("uses exact equality for a non-glob type and composes other filters", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);
    await repo.queryEventLogByOrg(
      ORG,
      { limit: 10, cursor: null },
      { type: "custom.order.placed", source: "custom-ingest", projectId: "p-uuid", from: "2026-07-01T00:00:00.000Z", to: "2026-07-05T00:00:00.000Z" },
    );
    expect(queries[0]!.text).toContain("type = $");
    expect(queries[0]!.text).toContain("source = $");
    expect(queries[0]!.text).toContain("project_id = $");
    expect(queries[0]!.text).toContain("occurred_at >= $");
    expect(queries[0]!.text).toContain("occurred_at <= $");
    expect(queries[0]!.params).toContain("custom.order.placed");
    expect(queries[0]!.params).toContain("custom-ingest");
    expect(queries[0]!.params).toContain("p-uuid");
  });

  it("computes a nextCursor when a full page + 1 is returned", async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      eventRow({ id: `evt_${"0".repeat(31)}${i}`, occurred_at: new Date(NOW.getTime() - i * 1000).toISOString() }),
    );
    const { executor } = createFakeExecutor({ rows });
    const repo = createEventsRepository(executor);
    const result = await repo.queryEventLogByOrg(ORG, { limit: 2, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(2);
      expect(result.value.nextCursor).not.toBeNull();
    }
  });

  it("appends a keyset cursor condition when a cursor is provided", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);
    await repo.queryEventLogByOrg(ORG, {
      limit: 10,
      cursor: { occurredAt: NOW.toISOString(), id: "evt_0123456789abcdef0123456789abcdef" },
    });
    expect(queries[0]!.text).toContain("(occurred_at, id) <");
  });
});

describe("events repository: findEventByIdempotencyKey", () => {
  it("returns the mapped event when a row matches", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [eventRow({ idempotency_key: "idem-1" })] });
    const repo = createEventsRepository(executor);
    const result = await repo.findEventByIdempotencyKey(ORG, "idem-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.idempotencyKey).toBe("idem-1");
    expect(queries[0]!.text).toContain("idempotency_key = $2");
    expect(queries[0]!.params).toEqual([ORG, "idem-1"]);
  });

  it("returns null (not an error) on no match", async () => {
    const { executor } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);
    const result = await repo.findEventByIdempotencyKey(ORG, "missing");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });
});

describe("events repository: countCustomEventsSince", () => {
  it("counts custom.% rows since a timestamp", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [{ count: 7 }] });
    const repo = createEventsRepository(executor);
    const result = await repo.countCustomEventsSince(ORG, "2026-07-05T00:00:00.000Z");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(7);
    expect(queries[0]!.text).toContain("type LIKE 'custom.%'");
    expect(queries[0]!.text).toContain("occurred_at >=");
  });

  it("coerces a bigint string count", async () => {
    const { executor } = createFakeExecutor({ rows: [{ count: "42" }] });
    const repo = createEventsRepository(executor);
    const result = await repo.countCustomEventsSince(ORG, "2026-07-05T00:00:00.000Z");
    if (result.ok) expect(result.value).toBe(42);
  });
});
