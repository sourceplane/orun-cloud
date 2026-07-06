import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { EventsResult } from "./types.js";

// ---------------------------------------------------------------------------
// Events admin/ops reads (saas-event-streaming ES7). Cross-org, read-only
// projections consumed by admin-worker's support-gated diagnostics surfaces:
// lane health, dead-letter counts, and the rule-storm audit. Same-context
// reads only (all against the events schema); bounded by an explicit LIMIT so
// no unbounded scan is reachable through the API.
// ---------------------------------------------------------------------------

export interface LaneHealthRow {
  laneKey: string;
  orgId: string;
  lastOccurredAt: Date | null;
  headOccurredAt: Date | null;
  lagSeconds: number;
}

export interface DeadLetterCountRow {
  orgId: string;
  openCount: number;
  terminalCount: number;
}

export interface SuppressedRuleRow {
  ruleId: string;
  orgId: string;
  name: string;
  suppressedAt: Date | null;
  suppressedReason: string | null;
  saturatedWindowCount: number;
}

export interface EventsAdminRepository {
  /**
   * Per (lane, org) lane lag: how far each cursor trails now, joined to the
   * org's event_log head so callers can see genuine backlog (head newer than
   * the cursor). Ordered worst-lag first, bounded by `limit`.
   */
  laneHealth(limit: number): Promise<EventsResult<LaneHealthRow[]>>;
  /** Open vs terminal dead-letter counts per org, worst (most open) first. */
  deadLetterCounts(limit: number): Promise<EventsResult<DeadLetterCountRow[]>>;
  /** Currently storm-suppressed rules, most recently suppressed first. */
  listSuppressedRules(limit: number): Promise<EventsResult<SuppressedRuleRow[]>>;
}

function safeError(message: string): EventsResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

function toNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function createEventsAdminRepository(executor: SqlExecutor): EventsAdminRepository {
  return {
    async laneHealth(limit) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT c.lane_key,
                  c.org_id,
                  c.last_occurred_at,
                  h.head_occurred_at,
                  GREATEST(0, EXTRACT(EPOCH FROM (now() - c.last_occurred_at)))::bigint AS lag_seconds
           FROM events.lane_cursors c
           LEFT JOIN LATERAL (
             SELECT max(e.occurred_at) AS head_occurred_at
             FROM events.event_log e
             WHERE e.org_id = c.org_id
           ) h ON true
           WHERE c.last_occurred_at IS NOT NULL
           ORDER BY lag_seconds DESC
           LIMIT $1`,
          [limit],
        );
        return {
          ok: true,
          value: result.rows.map((row) => ({
            laneKey: row.lane_key as string,
            orgId: row.org_id as string,
            lastOccurredAt: row.last_occurred_at ? new Date(row.last_occurred_at as string) : null,
            headOccurredAt: row.head_occurred_at ? new Date(row.head_occurred_at as string) : null,
            lagSeconds: toNum(row.lag_seconds),
          })),
        };
      } catch {
        return safeError("Failed to read lane health");
      }
    },

    async deadLetterCounts(limit) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT org_id,
                  count(*) FILTER (WHERE status = 'open')::bigint AS open_count,
                  count(*) FILTER (WHERE status IN ('replayed', 'discarded'))::bigint AS terminal_count
           FROM events.dead_letters
           GROUP BY org_id
           ORDER BY open_count DESC, org_id ASC
           LIMIT $1`,
          [limit],
        );
        return {
          ok: true,
          value: result.rows.map((row) => ({
            orgId: row.org_id as string,
            openCount: toNum(row.open_count),
            terminalCount: toNum(row.terminal_count),
          })),
        };
      } catch {
        return safeError("Failed to read dead-letter counts");
      }
    },

    async listSuppressedRules(limit) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, name, suppressed_at, suppressed_reason, saturated_window_count
           FROM events.notification_rules
           WHERE suppressed_at IS NOT NULL
           ORDER BY suppressed_at DESC, id ASC
           LIMIT $1`,
          [limit],
        );
        return {
          ok: true,
          value: result.rows.map((row) => ({
            ruleId: row.id as string,
            orgId: row.org_id as string,
            name: row.name as string,
            suppressedAt: row.suppressed_at ? new Date(row.suppressed_at as string) : null,
            suppressedReason: (row.suppressed_reason as string) ?? null,
            saturatedWindowCount: toNum(row.saturated_window_count),
          })),
        };
      } catch {
        return safeError("Failed to read suppressed rules");
      }
    },
  };
}
