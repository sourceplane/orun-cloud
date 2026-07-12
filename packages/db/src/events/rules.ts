import type { SqlExecutor } from "../hyperdrive/executor.js";
import type {
  EventsCursorPosition,
  EventsPagedResult,
  EventsPageQueryParams,
  EventsResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Notification rules storage (saas-event-streaming ES0): org/project-scoped
// routing rules and their delivery targets. Storage primitives only — the
// matching engine that evaluates them lands in ES2.
// ---------------------------------------------------------------------------

/** Severity ladder for in-SQL and in-JS rank comparisons (ES4). */
const SEVERITY_LADDER = ["info", "notice", "warning", "error", "critical"];

export type NotificationRuleStatus = "enabled" | "disabled" | "suppressed";
export type RuleTargetKind = "email" | "slack_channel" | "webhook_endpoint";
export type RuleFilterOp = "eq" | "neq" | "in";

export interface RuleAttributeFilter {
  /** Dot path into the event payload (e.g. "repoFullName"). */
  path: string;
  op: RuleFilterOp;
  value: unknown;
}

export interface StoredNotificationRule {
  id: string;
  orgId: string;
  projectId: string | null;
  name: string;
  status: NotificationRuleStatus;
  eventTypes: string[];
  minSeverity: string;
  sources: string[] | null;
  attributeFilters: RuleAttributeFilter[] | null;
  throttleWindowSeconds: number;
  throttleMax: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  // Storm-breaker state (ES7). suppressedAt is the auto-suppression overlay:
  // when set, `status` reads back as "suppressed" and the rule stops firing
  // until the cooldown clears it. saturatedWindowCount is the consecutive
  // throttle-saturation counter (reset on admit, incremented on deny).
  suppressedAt: Date | null;
  suppressedReason: string | null;
  saturatedWindowCount: number;
  lastSaturatedAt: Date | null;
}

/**
 * The outcome of a throttle admission attempt (ES7). `admitted` is the ES2
 * admit/deny decision; `saturatedWindows` is the rule's consecutive-saturation
 * count AFTER this attempt (0 on an admit) — the notifications lane trips the
 * circuit breaker once it crosses the storm threshold.
 */
export interface ThrottleAdmission {
  admitted: boolean;
  saturatedWindows: number;
}

/** Outcome of group-aware notification admission (ES4/IH2). */
export interface GroupNotifyDecision {
  /** Enqueue a notification for this event. */
  fire: boolean;
  /** The fire is a severity escalation of an already-notified story. */
  escalated: boolean;
}

export interface CreateNotificationRuleInput {
  id: string;
  orgId: string;
  projectId?: string | null;
  name: string;
  eventTypes: string[];
  minSeverity?: string;
  sources?: string[] | null;
  attributeFilters?: RuleAttributeFilter[] | null;
  throttleWindowSeconds?: number;
  throttleMax?: number;
  createdBy: string;
}

export interface UpdateNotificationRulePatch {
  name?: string;
  status?: NotificationRuleStatus;
  projectId?: string | null;
  eventTypes?: string[];
  minSeverity?: string;
  sources?: string[] | null;
  attributeFilters?: RuleAttributeFilter[] | null;
  throttleWindowSeconds?: number;
  throttleMax?: number;
}

export interface StoredRuleTarget {
  id: string;
  ruleId: string;
  orgId: string;
  targetKind: RuleTargetKind;
  targetRef: string;
  enabled: boolean;
  createdAt: Date;
}

export interface AddRuleTargetInput {
  id: string;
  ruleId: string;
  orgId: string;
  targetKind: RuleTargetKind;
  targetRef: string;
  enabled?: boolean;
}

export interface NotificationRulesRepository {
  createRule(input: CreateNotificationRuleInput): Promise<EventsResult<StoredNotificationRule>>;
  getRule(orgId: string, id: string): Promise<EventsResult<StoredNotificationRule | null>>;
  listRulesByOrg(
    orgId: string,
    params: EventsPageQueryParams,
  ): Promise<EventsResult<EventsPagedResult<StoredNotificationRule>>>;
  /** All enabled rules for an org — the lane handler's working set (small N). */
  listEnabledRulesByOrg(orgId: string): Promise<EventsResult<StoredNotificationRule[]>>;
  /**
   * Orgs with at least one enabled rule — the notifications lane's org
   * discovery (mirrors webhooks' listActiveOrgIds: only orgs that can match
   * anything get their cursor advanced).
   */
  listOrgIdsWithEnabledRules(): Promise<EventsResult<string[]>>;
  /** Total rules for the org (any status) — the entitlement limit gate. */
  countRulesByOrg(orgId: string): Promise<EventsResult<number>>;
  updateRule(
    orgId: string,
    id: string,
    patch: UpdateNotificationRulePatch,
  ): Promise<EventsResult<StoredNotificationRule | null>>;
  deleteRule(orgId: string, id: string): Promise<EventsResult<boolean>>;

  /**
   * Atomically consume one firing from the rule's fixed throttle window AND
   * maintain the storm-breaker bookkeeping in one statement. Returns
   * `admitted` (fired_count within throttleMax) plus `saturatedWindows` — the
   * rule's consecutive-saturation count after this attempt, reset to 0 on an
   * admit and incremented (with last_saturated_at) on a deny. A window opens at
   * the first fire and rolls when windowSeconds have elapsed. Single multi-CTE
   * statement — overlapping cron ticks cannot double-admit or double-count.
   */
  tryConsumeThrottle(
    ruleId: string,
    windowSeconds: number,
    throttleMax: number,
  ): Promise<EventsResult<ThrottleAdmission>>;

  /**
   * Auto-suppress a rule after sustained throttle saturation (ES7 circuit
   * breaker). Sets suppressed_at/suppressed_reason only when not already
   * suppressed; returns true when THIS call transitioned the rule (so the
   * caller emits the `notification_rule.suppressed` event + admin notice
   * exactly once). Idempotent: a second call on an already-suppressed rule
   * returns false.
   */
  suppressRuleForStorm(ruleId: string, reason: string): Promise<EventsResult<boolean>>;
  /**
   * Clear a single rule's suppression (cooldown re-enable): zeroes
   * suppressed_at/reason and the saturation counter so the rule resumes with a
   * fresh breaker. Returns true when a suppressed rule was cleared.
   */
  clearRuleSuppression(ruleId: string): Promise<EventsResult<boolean>>;
  /**
   * The once-per-tick cooldown pass: clear suppression on every rule whose
   * suppressed_at is older than `cutoffIso`. Returns the number of rules
   * re-enabled. Backed by notification_rules_suppressed_idx.
   */
  clearExpiredSuppressions(cutoffIso: string): Promise<EventsResult<number>>;

  /**
   * Group-aware notification admission (ES4). For a (rule, dedup group key),
   * record the high-water severity notified and decide whether this event
   * should fire — i.e. it opened the story (first) or escalated its severity
   * above what was already notified. Single-statement upsert: race-free per
   * (rule, group). `escalated` distinguishes the two fire causes (IH2: an
   * escalation renders as a thread reply on the story's Slack message).
   */
  tryNotifyGroup(
    ruleId: string,
    groupKey: string,
    severity: string,
  ): Promise<EventsResult<GroupNotifyDecision>>;

  addTarget(input: AddRuleTargetInput): Promise<EventsResult<StoredRuleTarget>>;
  listTargetsByRule(ruleId: string): Promise<EventsResult<StoredRuleTarget[]>>;
  listTargetsForRules(ruleIds: string[]): Promise<EventsResult<StoredRuleTarget[]>>;
  removeTarget(ruleId: string, targetId: string): Promise<EventsResult<boolean>>;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function parseJsonArrayColumn(value: unknown): unknown[] | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as unknown[]) : null;
  }
  if (Array.isArray(value)) return value as unknown[];
  return null;
}

function mapRule(row: Record<string, unknown>): StoredNotificationRule {
  const suppressedAt = row.suppressed_at ? new Date(row.suppressed_at as string) : null;
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    name: row.name as string,
    // The storm-breaker overlay wins the status read: a rule with
    // suppressed_at set surfaces as "suppressed" (the ES6 rules page banner)
    // regardless of the operator-set status column underneath.
    status: suppressedAt ? "suppressed" : (row.status as NotificationRuleStatus),
    eventTypes: (parseJsonArrayColumn(row.event_types) as string[]) ?? [],
    minSeverity: row.min_severity as string,
    sources: (parseJsonArrayColumn(row.sources) as string[] | null) ?? null,
    attributeFilters:
      (parseJsonArrayColumn(row.attribute_filters) as RuleAttributeFilter[] | null) ?? null,
    throttleWindowSeconds: row.throttle_window_seconds as number,
    throttleMax: row.throttle_max as number,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    suppressedAt,
    suppressedReason: (row.suppressed_reason as string) ?? null,
    saturatedWindowCount: (row.saturated_window_count as number) ?? 0,
    lastSaturatedAt: row.last_saturated_at ? new Date(row.last_saturated_at as string) : null,
  };
}

function mapTarget(row: Record<string, unknown>): StoredRuleTarget {
  return {
    id: row.id as string,
    ruleId: row.rule_id as string,
    orgId: row.org_id as string,
    targetKind: row.target_kind as RuleTargetKind,
    targetRef: row.target_ref as string,
    enabled: row.enabled as boolean,
    createdAt: new Date(row.created_at as string),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

function safeError(message: string): EventsResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

function buildCreatedCursorCondition(
  cursor: EventsCursorPosition | null,
  startParam: number,
): { clause: string; params: unknown[] } {
  if (!cursor) return { clause: "", params: [] };
  return {
    clause: ` AND (created_at, id) < ($${startParam}, $${startParam + 1})`,
    params: [cursor.occurredAt, cursor.id],
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNotificationRulesRepository(executor: SqlExecutor): NotificationRulesRepository {
  return {
    async createRule(input) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO events.notification_rules (
             id, org_id, project_id, name, event_types, min_severity,
             sources, attribute_filters, throttle_window_seconds, throttle_max, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId ?? null,
            input.name,
            JSON.stringify(input.eventTypes),
            input.minSeverity ?? "info",
            input.sources ? JSON.stringify(input.sources) : null,
            input.attributeFilters ? JSON.stringify(input.attributeFilters) : null,
            input.throttleWindowSeconds ?? 300,
            input.throttleMax ?? 10,
            input.createdBy,
          ],
        );
        return { ok: true, value: mapRule(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "notification_rule" } };
        }
        return safeError("Failed to create notification rule");
      }
    },

    async getRule(orgId, id) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.notification_rules WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        return { ok: true, value: result.rows.length ? mapRule(result.rows[0]!) : null };
      } catch {
        return safeError("Failed to read notification rule");
      }
    },

    async listRulesByOrg(orgId, params) {
      try {
        const values: unknown[] = [orgId];
        const cursorCondition = buildCreatedCursorCondition(params.cursor, 2);
        values.push(...cursorCondition.params);
        values.push(params.limit + 1);

        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.notification_rules
           WHERE org_id = $1${cursorCondition.clause}
           ORDER BY created_at DESC, id DESC
           LIMIT $${values.length}`,
          values,
        );
        const mapped = result.rows.map(mapRule);
        if (mapped.length > params.limit) {
          const trimmed = mapped.slice(0, params.limit);
          const last = trimmed[trimmed.length - 1]!;
          return {
            ok: true,
            value: {
              items: trimmed,
              nextCursor: { occurredAt: last.createdAt.toISOString(), id: last.id },
            },
          };
        }
        return { ok: true, value: { items: mapped, nextCursor: null } };
      } catch {
        return safeError("Failed to list notification rules");
      }
    },

    async listEnabledRulesByOrg(orgId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.notification_rules
           WHERE org_id = $1 AND status = 'enabled' AND suppressed_at IS NULL
           ORDER BY created_at ASC, id ASC`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapRule) };
      } catch {
        return safeError("Failed to list enabled notification rules");
      }
    },

    async listOrgIdsWithEnabledRules() {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT DISTINCT org_id FROM events.notification_rules WHERE status = 'enabled' AND suppressed_at IS NULL`,
        );
        return { ok: true, value: result.rows.map((row) => row.org_id as string) };
      } catch {
        return safeError("Failed to list orgs with enabled notification rules");
      }
    },

    async updateRule(orgId, id, patch) {
      try {
        const sets: string[] = [];
        const values: unknown[] = [orgId, id];
        const push = (fragment: string, value: unknown) => {
          values.push(value);
          sets.push(`${fragment} = $${values.length}`);
        };
        if (patch.name !== undefined) push("name", patch.name);
        if (patch.status !== undefined) push("status", patch.status);
        if (patch.projectId !== undefined) push("project_id", patch.projectId);
        if (patch.eventTypes !== undefined) push("event_types", JSON.stringify(patch.eventTypes));
        if (patch.minSeverity !== undefined) push("min_severity", patch.minSeverity);
        if (patch.sources !== undefined) {
          push("sources", patch.sources ? JSON.stringify(patch.sources) : null);
        }
        if (patch.attributeFilters !== undefined) {
          push(
            "attribute_filters",
            patch.attributeFilters ? JSON.stringify(patch.attributeFilters) : null,
          );
        }
        if (patch.throttleWindowSeconds !== undefined) {
          push("throttle_window_seconds", patch.throttleWindowSeconds);
        }
        if (patch.throttleMax !== undefined) push("throttle_max", patch.throttleMax);
        if (sets.length === 0) {
          const current = await executor.execute<Record<string, unknown>>(
            `SELECT * FROM events.notification_rules WHERE org_id = $1 AND id = $2`,
            [orgId, id],
          );
          return { ok: true, value: current.rows.length ? mapRule(current.rows[0]!) : null };
        }
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE events.notification_rules
           SET ${sets.join(", ")}, updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING *`,
          values,
        );
        return { ok: true, value: result.rows.length ? mapRule(result.rows[0]!) : null };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "notification_rule" } };
        }
        return safeError("Failed to update notification rule");
      }
    },

    async deleteRule(orgId, id) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM events.notification_rules WHERE org_id = $1 AND id = $2 RETURNING id`,
          [orgId, id],
        );
        return { ok: true, value: result.rows.length > 0 };
      } catch {
        return safeError("Failed to delete notification rule");
      }
    },

    async tryNotifyGroup(ruleId, groupKey, severity) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `WITH prior AS (
             SELECT max_notified_severity AS prev
             FROM events.rule_group_notifications
             WHERE rule_id = $1 AND group_key = $2
           ),
           up AS (
             INSERT INTO events.rule_group_notifications (rule_id, group_key, max_notified_severity)
             VALUES ($1, $2, $3)
             ON CONFLICT (rule_id, group_key) DO UPDATE SET
               max_notified_severity = CASE
                 WHEN array_position($4::text[], $3)
                    > array_position($4::text[], events.rule_group_notifications.max_notified_severity)
                 THEN $3 ELSE events.rule_group_notifications.max_notified_severity END,
               updated_at = now()
             RETURNING 1
           )
           SELECT (SELECT prev FROM prior) AS prev`,
          [ruleId, groupKey, severity, SEVERITY_LADDER],
        );
        const prev = (result.rows[0]?.prev as string | null) ?? null;
        // Fire when the story is new (no prior) or this event escalates it.
        const escalated =
          prev !== null && SEVERITY_LADDER.indexOf(severity) > SEVERITY_LADDER.indexOf(prev);
        return { ok: true, value: { fire: prev === null || escalated, escalated } };
      } catch {
        // Fail-closed: an unknown ledger state must not fan out a storm.
        return safeError("Failed to evaluate group notification");
      }
    },

    async countRulesByOrg(orgId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT count(*)::int AS total FROM events.notification_rules WHERE org_id = $1`,
          [orgId],
        );
        return { ok: true, value: (result.rows[0]?.total as number) ?? 0 };
      } catch {
        return safeError("Failed to count notification rules");
      }
    },

    async tryConsumeThrottle(ruleId, windowSeconds, throttleMax) {
      // windowSeconds 0 disables throttling entirely — no window, no breaker.
      if (windowSeconds <= 0) return { ok: true, value: { admitted: true, saturatedWindows: 0 } };
      try {
        // One multi-CTE statement: consume the throttle window (t), decide
        // admit/deny (adm), then maintain the storm-breaker counter on the rule
        // row (upd) — reset to 0 on an admit, +1 with last_saturated_at on a
        // deny. Atomic, so overlapping ticks cannot double-admit or skew the
        // consecutive-saturation count.
        const result = await executor.execute<Record<string, unknown>>(
          `WITH t AS (
             INSERT INTO events.rule_throttle_state (rule_id, window_started_at, fired_count, updated_at)
             VALUES ($1, now(), 1, now())
             ON CONFLICT (rule_id) DO UPDATE SET
               fired_count = CASE
                 WHEN events.rule_throttle_state.window_started_at < now() - make_interval(secs => $2)
                 THEN 1
                 ELSE events.rule_throttle_state.fired_count + 1
               END,
               window_started_at = CASE
                 WHEN events.rule_throttle_state.window_started_at < now() - make_interval(secs => $2)
                 THEN now()
                 ELSE events.rule_throttle_state.window_started_at
               END,
               updated_at = now()
             RETURNING fired_count
           ),
           adm AS (
             SELECT (SELECT fired_count FROM t) <= $3 AS admitted
           ),
           upd AS (
             UPDATE events.notification_rules nr
             SET saturated_window_count = CASE WHEN (SELECT admitted FROM adm)
                                               THEN 0 ELSE nr.saturated_window_count + 1 END,
                 last_saturated_at = CASE WHEN (SELECT admitted FROM adm)
                                         THEN nr.last_saturated_at ELSE now() END
             WHERE nr.id = $1
             RETURNING saturated_window_count
           )
           SELECT (SELECT admitted FROM adm) AS admitted,
                  (SELECT saturated_window_count FROM upd) AS saturated_windows`,
          [ruleId, windowSeconds, throttleMax],
        );
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            admitted: row.admitted === true,
            saturatedWindows: (row.saturated_windows as number) ?? 0,
          },
        };
      } catch {
        // Fail-closed: an unknown throttle state must not admit a storm.
        return safeError("Failed to consume rule throttle");
      }
    },

    async suppressRuleForStorm(ruleId, reason) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE events.notification_rules
           SET suppressed_at = now(), suppressed_reason = $2, updated_at = now()
           WHERE id = $1 AND suppressed_at IS NULL
           RETURNING id`,
          [ruleId, reason],
        );
        return { ok: true, value: result.rows.length > 0 };
      } catch {
        return safeError("Failed to suppress notification rule");
      }
    },

    async clearRuleSuppression(ruleId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE events.notification_rules
           SET suppressed_at = NULL, suppressed_reason = NULL,
               saturated_window_count = 0, last_saturated_at = NULL, updated_at = now()
           WHERE id = $1 AND suppressed_at IS NOT NULL
           RETURNING id`,
          [ruleId],
        );
        return { ok: true, value: result.rows.length > 0 };
      } catch {
        return safeError("Failed to clear rule suppression");
      }
    },

    async clearExpiredSuppressions(cutoffIso) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE events.notification_rules
           SET suppressed_at = NULL, suppressed_reason = NULL,
               saturated_window_count = 0, last_saturated_at = NULL, updated_at = now()
           WHERE suppressed_at IS NOT NULL AND suppressed_at < $1`,
          [cutoffIso],
        );
        return { ok: true, value: result.rowCount ?? 0 };
      } catch {
        return safeError("Failed to clear expired suppressions");
      }
    },

    async addTarget(input) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO events.rule_targets (id, rule_id, org_id, target_kind, target_ref, enabled)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            input.id,
            input.ruleId,
            input.orgId,
            input.targetKind,
            input.targetRef,
            input.enabled ?? true,
          ],
        );
        return { ok: true, value: mapTarget(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "rule_target" } };
        }
        return safeError("Failed to add rule target");
      }
    },

    async listTargetsByRule(ruleId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.rule_targets WHERE rule_id = $1 ORDER BY created_at ASC, id ASC`,
          [ruleId],
        );
        return { ok: true, value: result.rows.map(mapTarget) };
      } catch {
        return safeError("Failed to list rule targets");
      }
    },

    async listTargetsForRules(ruleIds) {
      if (ruleIds.length === 0) return { ok: true, value: [] };
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.rule_targets WHERE rule_id = ANY($1) ORDER BY created_at ASC, id ASC`,
          [ruleIds],
        );
        return { ok: true, value: result.rows.map(mapTarget) };
      } catch {
        return safeError("Failed to list rule targets");
      }
    },

    async removeTarget(ruleId, targetId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM events.rule_targets WHERE rule_id = $1 AND id = $2 RETURNING id`,
          [ruleId, targetId],
        );
        return { ok: true, value: result.rows.length > 0 };
      } catch {
        return safeError("Failed to remove rule target");
      }
    },
  };
}
