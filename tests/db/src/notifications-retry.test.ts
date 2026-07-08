import { createNotificationsRepository } from "@saas/db/notifications";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(rows: Record<string, unknown>[] = []): {
  executor: SqlExecutor;
  queries: QueryRecord[];
} {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      return { rows: rows as unknown as T[], rowCount: rows.length };
    },
  };
  return { executor, queries };
}

const NOW = "2026-07-05T10:00:00.000Z";

describe("notifications retry SQL (ES3)", () => {
  it("listRetryableNotifications selects due failed rows oldest-first", async () => {
    const { executor, queries } = createFakeExecutor([]);
    const repo = createNotificationsRepository(executor);
    await repo.listRetryableNotifications(50);
    const sql = queries[0]!.text;
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain("next_retry_at IS NOT NULL");
    expect(sql).toContain("next_retry_at <= now()");
    expect(sql).toContain("ORDER BY next_retry_at ASC");
    expect(queries[0]!.params).toEqual([50]);
  });

  it("markNotificationStatus writes next_retry_at and attempt_count only when provided", async () => {
    const row = {
      id: "n1", org_id: "o1", category: "product", template_key: "event.notification",
      template_data: "{}", channel: "slack", recipient_address: "chan_x", recipient_subject_kind: null,
      recipient_subject_id: null, status: "failed", provider_message_id: null, last_error: "slack_http_500",
      idempotency_key: null, correlation_id: null, queued_at: NOW, sent_at: null, failed_at: NOW,
      updated_at: NOW, next_retry_at: NOW, attempt_count: 2,
    };
    const { executor, queries } = createFakeExecutor([row]);
    const repo = createNotificationsRepository(executor);

    const scheduled = await repo.markNotificationStatus({
      id: "n1", orgId: "o1", status: "failed", lastError: "slack_http_500",
      failedAt: new Date(NOW), updatedAt: new Date(NOW), nextRetryAt: new Date(NOW), attemptCount: 2,
    });
    expect(scheduled.ok).toBe(true);
    if (scheduled.ok) {
      expect(scheduled.value.nextRetryAt).not.toBeNull();
      expect(scheduled.value.attemptCount).toBe(2);
    }
    // CASE-gated columns present with the "set" flags true.
    expect(queries[0]!.text).toContain("next_retry_at = CASE WHEN");
    expect(queries[0]!.text).toContain("attempt_count = CASE WHEN");
    const params = queries[0]!.params;
    expect(params[8]).toBe(true); // setNextRetry
    expect(params[10]).toBe(true); // setAttemptCount

    // Omitting the fields leaves the columns untouched (set flags false).
    const { executor: ex2, queries: q2 } = createFakeExecutor([row]);
    const repo2 = createNotificationsRepository(ex2);
    await repo2.markNotificationStatus({ id: "n1", orgId: "o1", status: "sent", updatedAt: new Date(NOW) });
    expect(q2[0]!.params[8]).toBe(false);
    expect(q2[0]!.params[10]).toBe(false);
  });
});
