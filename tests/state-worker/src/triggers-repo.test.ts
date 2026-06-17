// OV4 — scm.* trigger projection repository. Verifies idempotent recording (by
// the source event id), the ingestion cursor (read default + advance upsert),
// and the activity-feed listing. DB is an in-memory triggers store interpreting
// the repo's SQL so the idempotency semantics behave like a real ON CONFLICT.

import { createStateRepository } from "@saas/db/state";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";

// In-memory store keyed by event_id (the uq_state_triggers_event idempotency
// keystone) plus a single-row cursor.
function triggersExecutor(): { executor: SqlExecutor; triggers: Map<string, Record<string, unknown>>; cursor: Record<string, unknown> } {
  const triggers = new Map<string, Record<string, unknown>>();
  const cursor: Record<string, unknown> = {};
  const executor: SqlExecutor = {
    execute<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<SqlExecutorResult<T>> {
      const rows = run(text, params) as unknown as T[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as SqlExecutor;

  function run(text: string, p: unknown[]): Record<string, unknown>[] {
    if (text.includes("INSERT INTO state.triggers")) {
      const eventId = p[13] as string;
      if (triggers.has(eventId)) return []; // ON CONFLICT (event_id) DO NOTHING
      const row: Record<string, unknown> = {
        id: p[0] as string,
        org_id: p[1] as string,
        project_id: (p[2] as string) ?? null,
        provider: p[3] as string,
        provider_repo_id: p[4] as string,
        repo_full_name: (p[5] as string) ?? null,
        kind: p[6] as string,
        action: (p[7] as string) ?? null,
        ref: (p[8] as string) ?? null,
        commit_sha: p[9] as string,
        base_sha: (p[10] as string) ?? null,
        pr_number: (p[11] as number) ?? null,
        actor_login: (p[12] as string) ?? null,
        event_id: eventId,
        status: "recorded",
        occurred_at: String(p[14]),
        created_at: "2026-06-17T00:00:00.000Z",
      };
      triggers.set(eventId, row);
      return [row];
    }
    if (text.includes("SELECT * FROM state.triggers WHERE event_id")) {
      const r = triggers.get(p[0] as string);
      return r ? [r] : [];
    }
    if (text.includes("SELECT last_occurred_at, last_event_id FROM state.scm_ingest_cursor")) {
      return cursor.last_event_id ? [cursor] : [];
    }
    if (text.includes("INSERT INTO state.scm_ingest_cursor")) {
      cursor.last_occurred_at = p[0];
      cursor.last_event_id = p[1];
      return [];
    }
    if (text.includes("SELECT * FROM state.triggers WHERE org_id")) {
      return [...triggers.values()].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
    }
    return [];
  }

  return { executor, triggers, cursor };
}

function pushInput(over?: Record<string, unknown>) {
  return {
    id: "t1",
    orgId: asUuid(ORG),
    projectId: asUuid(PROJECT),
    provider: "github",
    providerRepoId: "123456",
    repoFullName: "acme/platform",
    kind: "push" as const,
    ref: "refs/heads/main",
    commitSha: "abc123",
    eventId: "evt_1",
    occurredAt: new Date("2026-06-17T10:00:00Z"),
    ...over,
  };
}

describe("StateRepository scm.* triggers (OV4)", () => {
  it("records a trigger, and a re-record of the same event is an idempotent no-op", async () => {
    const { executor, triggers } = triggersExecutor();
    const repo = createStateRepository(executor);

    const first = await repo.recordTrigger(pushInput());
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.created).toBe(true);
    expect(triggers.size).toBe(1);

    // Same event id (a redelivery / reprocess) — no new row, created=false.
    const again = await repo.recordTrigger(pushInput({ id: "t1-dup" }));
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.value.created).toBe(false);
      expect(again.value.trigger.eventId).toBe("evt_1");
    }
    expect(triggers.size).toBe(1);
  });

  it("reads a default-empty cursor then advances it", async () => {
    const { executor } = triggersExecutor();
    const repo = createStateRepository(executor);

    const empty = await repo.readScmIngestCursor();
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value).toEqual({ lastOccurredAt: null, lastEventId: null });

    await repo.advanceScmIngestCursor("2026-06-17T10:00:00.000Z", "evt_9");
    const after = await repo.readScmIngestCursor();
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value.lastEventId).toBe("evt_9");
  });

  it("lists triggers newest-first for the activity feed", async () => {
    const { executor } = triggersExecutor();
    const repo = createStateRepository(executor);
    await repo.recordTrigger(pushInput({ eventId: "evt_a", occurredAt: new Date("2026-06-17T10:00:00Z") }));
    await repo.recordTrigger(
      pushInput({ id: "t2", eventId: "evt_b", commitSha: "def456", occurredAt: new Date("2026-06-17T11:00:00Z") }),
    );

    const list = await repo.listTriggers(asUuid(ORG), { limit: 10, cursor: null });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.items).toHaveLength(2);
      expect(list.value.items[0]!.eventId).toBe("evt_b"); // newest first
    }
  });
});
