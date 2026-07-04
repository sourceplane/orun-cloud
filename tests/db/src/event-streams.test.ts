import {
  createEventStreamsRepository,
  createNotificationRulesRepository,
  createEventGroupsRepository,
} from "@saas/db/events";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  error?: unknown;
  rowCount?: number;
  callResponses?: Array<{ rows?: Record<string, unknown>[]; rowCount?: number; error?: unknown }>;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  let callIndex = 0;
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });

      if (options?.callResponses && callIndex < options.callResponses.length) {
        const response = options.callResponses[callIndex]!;
        callIndex++;
        if (response.error) throw response.error;
        const rows = (response.rows ?? []) as unknown as T[];
        return { rows, rowCount: response.rowCount ?? rows.length };
      }

      if (options?.error) throw options.error;
      const rows = (options?.rows ?? []) as unknown as T[];
      return { rows, rowCount: options?.rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-07-01T10:00:00Z");

const SAMPLE_LANE_ROW = {
  lane_key: "webhooks",
  owner_context: "webhooks",
  description: "Outbound webhook fan-out",
  type_filter: JSON.stringify([]),
  status: "active",
  batch_size: 100,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_CURSOR_ROW = {
  lane_key: "webhooks",
  org_id: "org-001",
  last_event_id: "evt-050",
  last_occurred_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_DEAD_LETTER_ROW = {
  id: "dl_0123456789abcdef0123456789abcdef",
  lane_key: "notifications",
  event_id: "evt-100",
  org_id: "org-001",
  reason: "handler threw: boom",
  attempts: 1,
  status: "open",
  first_failed_at: NOW.toISOString(),
  last_failed_at: NOW.toISOString(),
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_RULE_ROW = {
  id: "rule_0123456789abcdef0123456789abcdef",
  org_id: "org-001",
  project_id: null,
  name: "Slack on PR merges",
  status: "enabled",
  event_types: JSON.stringify(["scm.pull_request.*"]),
  min_severity: "info",
  sources: null,
  attribute_filters: JSON.stringify([{ path: "repoFullName", op: "eq", value: "acme/api" }]),
  throttle_window_seconds: 300,
  throttle_max: 10,
  created_by: "usr-001",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_TARGET_ROW = {
  id: "rtgt_0123456789abcdef0123456789abcdef",
  rule_id: SAMPLE_RULE_ROW.id,
  org_id: "org-001",
  target_kind: "email",
  target_ref: "ops@acme.test",
  enabled: true,
  created_at: NOW.toISOString(),
};

const SAMPLE_GROUP_ROW = {
  id: "grp_0123456789abcdef0123456789abcdef",
  org_id: "org-001",
  group_key: "run:org-001:acme/api:abc123",
  status: "open",
  first_event_id: "evt-200",
  last_event_id: "evt-201",
  event_count: 2,
  max_severity: "notice",
  first_at: NOW.toISOString(),
  last_at: NOW.toISOString(),
  closed_at: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

describe("event streams repository", () => {
  it("upsertLane writes registry fields but never status", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_LANE_ROW] });
    const repo = createEventStreamsRepository(executor);
    const result = await repo.upsertLane({
      laneKey: "webhooks",
      ownerContext: "webhooks",
      description: "Outbound webhook fan-out",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.laneKey).toBe("webhooks");
      expect(result.value.typeFilter).toEqual([]);
    }
    expect(queries[0]!.text).toContain("INSERT INTO events.subscriber_lanes");
    expect(queries[0]!.text).toContain("ON CONFLICT (lane_key) DO UPDATE");
    // Pausing is deliberate: re-registration must not flip status.
    expect(queries[0]!.text.split("DO UPDATE")[1]).not.toContain("status");
  });

  it("setLaneStatus pauses a lane", async () => {
    const { executor, queries } = createFakeExecutor({
      rows: [{ ...SAMPLE_LANE_ROW, status: "paused" }],
    });
    const repo = createEventStreamsRepository(executor);
    const result = await repo.setLaneStatus("webhooks", "paused");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value!.status).toBe("paused");
    expect(queries[0]!.params).toEqual(["webhooks", "paused"]);
  });

  it("getLaneCursor returns the synthetic zero cursor when absent", async () => {
    const { executor } = createFakeExecutor({ rows: [] });
    const repo = createEventStreamsRepository(executor);
    const result = await repo.getLaneCursor("notifications", "org-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lastEventId).toBeNull();
      expect(result.value.lastOccurredAt).toBeNull();
      expect(result.value.updatedAt.getTime()).toBe(0);
    }
  });

  it("advanceLaneCursor upserts on (lane_key, org_id)", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_CURSOR_ROW] });
    const repo = createEventStreamsRepository(executor);
    const result = await repo.advanceLaneCursor(
      "webhooks",
      "org-001",
      "evt-050",
      NOW.toISOString(),
    );
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("ON CONFLICT (lane_key, org_id)");
    expect(queries[0]!.params).toEqual(["webhooks", "org-001", "evt-050", NOW.toISOString()]);
  });

  it("recordDeadLetter upserts per (lane, event) and increments attempts", async () => {
    const { executor, queries } = createFakeExecutor({
      rows: [{ ...SAMPLE_DEAD_LETTER_ROW, attempts: 2 }],
    });
    const repo = createEventStreamsRepository(executor);
    const result = await repo.recordDeadLetter({
      id: SAMPLE_DEAD_LETTER_ROW.id,
      laneKey: "notifications",
      eventId: "evt-100",
      orgId: "org-001",
      reason: "handler threw: boom",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.attempts).toBe(2);
    expect(queries[0]!.text).toContain("ON CONFLICT ON CONSTRAINT dead_letters_lane_event_uq");
    expect(queries[0]!.text).toContain("attempts = events.dead_letters.attempts + 1");
  });

  it("listDeadLettersByOrg pages by (created_at, id) and trims to limit", async () => {
    const second = { ...SAMPLE_DEAD_LETTER_ROW, id: "dl_2" };
    const third = { ...SAMPLE_DEAD_LETTER_ROW, id: "dl_3" };
    const { executor, queries } = createFakeExecutor({
      rows: [SAMPLE_DEAD_LETTER_ROW, second, third],
    });
    const repo = createEventStreamsRepository(executor);
    const result = await repo.listDeadLettersByOrg("org-001", { limit: 2, cursor: null }, "open");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(2);
      expect(result.value.nextCursor).not.toBeNull();
    }
    expect(queries[0]!.text).toContain("status = $2");
    expect(queries[0]!.params).toEqual(["org-001", "open", 3]);
  });

  it("surfaces infra failures as internal errors", async () => {
    const { executor } = createFakeExecutor({ error: new Error("boom") });
    const repo = createEventStreamsRepository(executor);
    const result = await repo.listLanes();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal");
  });
});

describe("notification rules repository", () => {
  it("createRule serializes match clauses and applies defaults", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_RULE_ROW] });
    const repo = createNotificationRulesRepository(executor);
    const result = await repo.createRule({
      id: SAMPLE_RULE_ROW.id,
      orgId: "org-001",
      name: "Slack on PR merges",
      eventTypes: ["scm.pull_request.*"],
      attributeFilters: [{ path: "repoFullName", op: "eq", value: "acme/api" }],
      createdBy: "usr-001",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventTypes).toEqual(["scm.pull_request.*"]);
      expect(result.value.attributeFilters).toEqual([
        { path: "repoFullName", op: "eq", value: "acme/api" },
      ]);
    }
    expect(queries[0]!.text).toContain("INSERT INTO events.notification_rules");
    // Defaults: min_severity info, throttle 300s/10, null project.
    expect(queries[0]!.params[5]).toBe("info");
    expect(queries[0]!.params[8]).toBe(300);
    expect(queries[0]!.params[9]).toBe(10);
  });

  it("createRule maps unique violations to conflict", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23505" } });
    const repo = createNotificationRulesRepository(executor);
    const result = await repo.createRule({
      id: "rule_x",
      orgId: "org-001",
      name: "dup",
      eventTypes: ["*"],
      createdBy: "usr-001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ kind: "conflict", entity: "notification_rule" });
  });

  it("updateRule builds a partial SET clause", async () => {
    const { executor, queries } = createFakeExecutor({
      rows: [{ ...SAMPLE_RULE_ROW, status: "disabled" }],
    });
    const repo = createNotificationRulesRepository(executor);
    const result = await repo.updateRule("org-001", SAMPLE_RULE_ROW.id, {
      status: "disabled",
      throttleMax: 5,
    });
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("SET status = $3, throttle_max = $4");
    expect(queries[0]!.params).toEqual(["org-001", SAMPLE_RULE_ROW.id, "disabled", 5]);
  });

  it("listEnabledRulesByOrg filters on status", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_RULE_ROW] });
    const repo = createNotificationRulesRepository(executor);
    const result = await repo.listEnabledRulesByOrg("org-001");
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("status = 'enabled'");
  });

  it("targets: add, list-for-rules, remove", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_TARGET_ROW] });
    const repo = createNotificationRulesRepository(executor);

    const added = await repo.addTarget({
      id: SAMPLE_TARGET_ROW.id,
      ruleId: SAMPLE_RULE_ROW.id,
      orgId: "org-001",
      targetKind: "email",
      targetRef: "ops@acme.test",
    });
    expect(added.ok).toBe(true);
    expect(queries[0]!.params[5]).toBe(true);

    const forRules = await repo.listTargetsForRules([SAMPLE_RULE_ROW.id]);
    expect(forRules.ok).toBe(true);
    expect(queries[1]!.text).toContain("rule_id = ANY($1)");

    const empty = await repo.listTargetsForRules([]);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value).toEqual([]);
    // No query issued for the empty id list.
    expect(queries).toHaveLength(2);

    const removed = await repo.removeTarget(SAMPLE_RULE_ROW.id, SAMPLE_TARGET_ROW.id);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value).toBe(true);
  });
});

describe("event groups repository", () => {
  it("createGroup seeds first==last and count 1", async () => {
    const { executor, queries } = createFakeExecutor({
      rows: [{ ...SAMPLE_GROUP_ROW, last_event_id: "evt-200", event_count: 1 }],
    });
    const repo = createEventGroupsRepository(executor);
    const result = await repo.createGroup({
      id: SAMPLE_GROUP_ROW.id,
      orgId: "org-001",
      groupKey: SAMPLE_GROUP_ROW.group_key,
      firstEventId: "evt-200",
      severity: "info",
      occurredAt: NOW.toISOString(),
    });
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("VALUES ($1, $2, $3, $4, $4, 1, $5, $6, $6)");
  });

  it("createGroup maps the open-key race to conflict", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23505" } });
    const repo = createEventGroupsRepository(executor);
    const result = await repo.createGroup({
      id: "grp_x",
      orgId: "org-001",
      groupKey: "run:org-001:acme/api:abc123",
      firstEventId: "evt-1",
      severity: "info",
      occurredAt: NOW.toISOString(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ kind: "conflict", entity: "event_group" });
  });

  it("appendMember is idempotent per (group, event) and escalates severity in SQL", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_GROUP_ROW] });
    const repo = createEventGroupsRepository(executor);
    const result = await repo.appendMember({
      groupId: SAMPLE_GROUP_ROW.id,
      eventId: "evt-201",
      severity: "notice",
      occurredAt: NOW.toISOString(),
    });
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("ON CONFLICT DO NOTHING");
    expect(queries[0]!.text).toContain("array_position");
    expect(queries[0]!.params[4]).toEqual(["info", "notice", "warning", "error", "critical"]);
  });

  it("closeGroup only closes open groups", async () => {
    const { executor, queries } = createFakeExecutor({
      rows: [{ ...SAMPLE_GROUP_ROW, status: "closed", closed_at: NOW.toISOString() }],
    });
    const repo = createEventGroupsRepository(executor);
    const result = await repo.closeGroup("org-001", SAMPLE_GROUP_ROW.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value!.status).toBe("closed");
    expect(queries[0]!.text).toContain("AND status = 'open'");
  });

  it("closeInactiveGroups closes by last_at cutoff", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventGroupsRepository(executor);
    const result = await repo.closeInactiveGroups(NOW.toISOString());
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("last_at < $1");
  });

  it("listGroupsByOrg orders by (last_at, id) descending", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_GROUP_ROW] });
    const repo = createEventGroupsRepository(executor);
    const result = await repo.listGroupsByOrg("org-001", { limit: 20, cursor: null }, "open");
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("ORDER BY last_at DESC, id DESC");
  });
});
