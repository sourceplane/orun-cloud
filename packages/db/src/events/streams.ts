import type { SqlExecutor } from "../hyperdrive/executor.js";
import type {
  EventsCursorPosition,
  EventsPagedResult,
  EventsPageQueryParams,
  EventsResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Event streams storage (saas-event-streaming ES0): the subscriber-lane
// registry, per-(lane, org) dispatch cursors, and the dead-letter store.
// Storage primitives only — the dispatcher that consumes them lands in ES1.
// ---------------------------------------------------------------------------

export type SubscriberLaneStatus = "active" | "paused";
export type DeadLetterStatus = "open" | "replayed" | "discarded";

export interface StoredSubscriberLane {
  laneKey: string;
  ownerContext: string;
  description: string;
  typeFilter: string[];
  status: SubscriberLaneStatus;
  batchSize: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertSubscriberLaneInput {
  laneKey: string;
  ownerContext: string;
  description?: string;
  typeFilter?: string[];
  batchSize?: number;
}

export interface StoredLaneCursor {
  laneKey: string;
  orgId: string;
  lastEventId: string | null;
  lastOccurredAt: Date | null;
  updatedAt: Date;
}

export interface StoredDeadLetter {
  id: string;
  laneKey: string;
  eventId: string;
  orgId: string;
  reason: string;
  attempts: number;
  status: DeadLetterStatus;
  firstFailedAt: Date;
  lastFailedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecordDeadLetterInput {
  /** Public id (dl_<hex>) used only when this (lane, event) has no row yet. */
  id: string;
  laneKey: string;
  eventId: string;
  orgId: string;
  /** Safe, bounded failure summary — never raw provider bodies or secrets. */
  reason: string;
}

export interface EventStreamsRepository {
  /**
   * Register or refresh a lane. Never touches `status` — pausing/resuming is
   * a deliberate operational action via setLaneStatus, not a side effect of
   * re-registration at deploy time.
   */
  upsertLane(input: UpsertSubscriberLaneInput): Promise<EventsResult<StoredSubscriberLane>>;
  listLanes(): Promise<EventsResult<StoredSubscriberLane[]>>;
  getLane(laneKey: string): Promise<EventsResult<StoredSubscriberLane | null>>;
  setLaneStatus(laneKey: string, status: SubscriberLaneStatus): Promise<EventsResult<StoredSubscriberLane | null>>;

  /** Returns a synthetic zero cursor when the (lane, org) has no row yet. */
  getLaneCursor(laneKey: string, orgId: string): Promise<EventsResult<StoredLaneCursor>>;
  advanceLaneCursor(
    laneKey: string,
    orgId: string,
    lastEventId: string,
    lastOccurredAt: string,
  ): Promise<EventsResult<StoredLaneCursor>>;

  /**
   * Record a dead letter. One row per (lane, event): a repeat failure
   * increments `attempts`, refreshes `last_failed_at`/`reason`, and reopens
   * the row — it never forks a second dead letter for the same event.
   */
  recordDeadLetter(input: RecordDeadLetterInput): Promise<EventsResult<StoredDeadLetter>>;
  getDeadLetter(orgId: string, id: string): Promise<EventsResult<StoredDeadLetter | null>>;
  listDeadLettersByOrg(
    orgId: string,
    params: EventsPageQueryParams,
    status?: DeadLetterStatus,
  ): Promise<EventsResult<EventsPagedResult<StoredDeadLetter>>>;
  markDeadLetter(
    orgId: string,
    id: string,
    status: DeadLetterStatus,
  ): Promise<EventsResult<StoredDeadLetter | null>>;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function parseJsonArrayColumn(value: unknown): string[] {
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  }
  if (Array.isArray(value)) return value as string[];
  return [];
}

function mapLane(row: Record<string, unknown>): StoredSubscriberLane {
  return {
    laneKey: row.lane_key as string,
    ownerContext: row.owner_context as string,
    description: row.description as string,
    typeFilter: parseJsonArrayColumn(row.type_filter),
    status: row.status as SubscriberLaneStatus,
    batchSize: row.batch_size as number,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapCursor(row: Record<string, unknown>): StoredLaneCursor {
  return {
    laneKey: row.lane_key as string,
    orgId: row.org_id as string,
    lastEventId: (row.last_event_id as string) ?? null,
    lastOccurredAt: row.last_occurred_at ? new Date(row.last_occurred_at as string) : null,
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapDeadLetter(row: Record<string, unknown>): StoredDeadLetter {
  return {
    id: row.id as string,
    laneKey: row.lane_key as string,
    eventId: row.event_id as string,
    orgId: row.org_id as string,
    reason: row.reason as string,
    attempts: row.attempts as number,
    status: row.status as DeadLetterStatus,
    firstFailedAt: new Date(row.first_failed_at as string),
    lastFailedAt: new Date(row.last_failed_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
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

export function createEventStreamsRepository(executor: SqlExecutor): EventStreamsRepository {
  return {
    async upsertLane(input) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO events.subscriber_lanes (lane_key, owner_context, description, type_filter, batch_size)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (lane_key) DO UPDATE SET
             owner_context = $2,
             description = $3,
             type_filter = $4,
             batch_size = $5,
             updated_at = now()
           RETURNING *`,
          [
            input.laneKey,
            input.ownerContext,
            input.description ?? "",
            JSON.stringify(input.typeFilter ?? []),
            input.batchSize ?? 100,
          ],
        );
        return { ok: true, value: mapLane(result.rows[0]!) };
      } catch {
        return safeError("Failed to upsert subscriber lane");
      }
    },

    async listLanes() {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.subscriber_lanes ORDER BY lane_key ASC`,
        );
        return { ok: true, value: result.rows.map(mapLane) };
      } catch {
        return safeError("Failed to list subscriber lanes");
      }
    },

    async getLane(laneKey) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.subscriber_lanes WHERE lane_key = $1`,
          [laneKey],
        );
        return { ok: true, value: result.rows.length ? mapLane(result.rows[0]!) : null };
      } catch {
        return safeError("Failed to read subscriber lane");
      }
    },

    async setLaneStatus(laneKey, status) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE events.subscriber_lanes SET status = $2, updated_at = now()
           WHERE lane_key = $1
           RETURNING *`,
          [laneKey, status],
        );
        return { ok: true, value: result.rows.length ? mapLane(result.rows[0]!) : null };
      } catch {
        return safeError("Failed to set lane status");
      }
    },

    async getLaneCursor(laneKey, orgId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT lane_key, org_id, last_event_id, last_occurred_at, updated_at
           FROM events.lane_cursors
           WHERE lane_key = $1 AND org_id = $2`,
          [laneKey, orgId],
        );
        if (result.rows.length === 0) {
          return {
            ok: true,
            value: {
              laneKey,
              orgId,
              lastEventId: null,
              lastOccurredAt: null,
              updatedAt: new Date(0),
            },
          };
        }
        return { ok: true, value: mapCursor(result.rows[0]!) };
      } catch {
        return safeError("Failed to read lane cursor");
      }
    },

    async advanceLaneCursor(laneKey, orgId, lastEventId, lastOccurredAt) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO events.lane_cursors (lane_key, org_id, last_event_id, last_occurred_at, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (lane_key, org_id)
           DO UPDATE SET last_event_id = $3, last_occurred_at = $4, updated_at = now()
           RETURNING *`,
          [laneKey, orgId, lastEventId, lastOccurredAt],
        );
        return { ok: true, value: mapCursor(result.rows[0]!) };
      } catch {
        return safeError("Failed to advance lane cursor");
      }
    },

    async recordDeadLetter(input) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO events.dead_letters (id, lane_key, event_id, org_id, reason)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ON CONSTRAINT dead_letters_lane_event_uq
           DO UPDATE SET
             attempts = events.dead_letters.attempts + 1,
             reason = $5,
             status = 'open',
             last_failed_at = now(),
             updated_at = now()
           RETURNING *`,
          [input.id, input.laneKey, input.eventId, input.orgId, input.reason],
        );
        return { ok: true, value: mapDeadLetter(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          // The only unique constraints are the PK (fresh id collision) and
          // the (lane, event) pair handled by the upsert — reaching here means
          // an id collision, which the caller can safely retry.
          return { ok: false, error: { kind: "conflict", entity: "dead_letter" } };
        }
        return safeError("Failed to record dead letter");
      }
    },

    async getDeadLetter(orgId, id) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.dead_letters WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        return { ok: true, value: result.rows.length ? mapDeadLetter(result.rows[0]!) : null };
      } catch {
        return safeError("Failed to read dead letter");
      }
    },

    async listDeadLettersByOrg(orgId, params, status) {
      try {
        const conditions: string[] = ["org_id = $1"];
        const values: unknown[] = [orgId];
        if (status) {
          values.push(status);
          conditions.push(`status = $${values.length}`);
        }
        const cursorCondition = buildCreatedCursorCondition(params.cursor, values.length + 1);
        values.push(...cursorCondition.params);
        values.push(params.limit + 1);

        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.dead_letters
           WHERE ${conditions.join(" AND ")}${cursorCondition.clause}
           ORDER BY created_at DESC, id DESC
           LIMIT $${values.length}`,
          values,
        );
        const mapped = result.rows.map(mapDeadLetter);
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
        return safeError("Failed to list dead letters");
      }
    },

    async markDeadLetter(orgId, id, status) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE events.dead_letters SET status = $3, updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING *`,
          [orgId, id, status],
        );
        return { ok: true, value: result.rows.length ? mapDeadLetter(result.rows[0]!) : null };
      } catch {
        return safeError("Failed to update dead letter");
      }
    },
  };
}
