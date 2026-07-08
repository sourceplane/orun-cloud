import type { SqlExecutor } from "../hyperdrive/executor.js";
import type {
  EventsCursorPosition,
  EventsPagedResult,
  EventsPageQueryParams,
  EventsResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Event groups storage (saas-event-streaming ES0): the dedup/correlation
// read-model — one open story per (org, rendered dedup key). Storage
// primitives only; the grouping lane that drives them lands in ES4.
// Groups are an overlay: nothing here ever mutates events.event_log.
// ---------------------------------------------------------------------------

export type EventGroupStatus = "open" | "closed";

/** Severity ladder used for in-SQL escalation comparisons. */
const SEVERITY_LADDER = ["info", "notice", "warning", "error", "critical"];

export interface StoredEventGroup {
  id: string;
  orgId: string;
  groupKey: string;
  status: EventGroupStatus;
  firstEventId: string;
  lastEventId: string;
  eventCount: number;
  maxSeverity: string;
  firstAt: Date;
  lastAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEventGroupInput {
  id: string;
  orgId: string;
  groupKey: string;
  firstEventId: string;
  severity: string;
  occurredAt: string;
}

export interface AppendGroupMemberInput {
  groupId: string;
  eventId: string;
  /** Candidate severity — the group's max only ever escalates. */
  severity: string;
  occurredAt: string;
}

export interface StoredEventGroupMember {
  groupId: string;
  eventId: string;
  addedAt: Date;
}

export interface EventGroupsRepository {
  /**
   * Open a new group for a rendered dedup key. The partial unique index
   * (org_id, group_key) WHERE status = 'open' is the correlation invariant:
   * a concurrent open for the same key surfaces as a conflict and the caller
   * re-reads the winner via getOpenGroupByKey.
   */
  createGroup(input: CreateEventGroupInput): Promise<EventsResult<StoredEventGroup>>;
  getOpenGroupByKey(orgId: string, groupKey: string): Promise<EventsResult<StoredEventGroup | null>>;
  getGroup(orgId: string, id: string): Promise<EventsResult<StoredEventGroup | null>>;
  /**
   * Add an event to a group and roll the group forward (last event, count,
   * escalate-only max severity, last_at) in one statement. Idempotent per
   * (group, event): a duplicate append changes nothing.
   */
  appendMember(input: AppendGroupMemberInput): Promise<EventsResult<StoredEventGroup | null>>;
  closeGroup(orgId: string, id: string): Promise<EventsResult<StoredEventGroup | null>>;
  /** Close every open group whose last activity predates the cutoff. */
  closeInactiveGroups(cutoff: string): Promise<EventsResult<StoredEventGroup[]>>;
  listGroupsByOrg(
    orgId: string,
    params: EventsPageQueryParams,
    status?: EventGroupStatus,
  ): Promise<EventsResult<EventsPagedResult<StoredEventGroup>>>;
  listMembers(groupId: string): Promise<EventsResult<StoredEventGroupMember[]>>;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapGroup(row: Record<string, unknown>): StoredEventGroup {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    groupKey: row.group_key as string,
    status: row.status as EventGroupStatus,
    firstEventId: row.first_event_id as string,
    lastEventId: row.last_event_id as string,
    eventCount: row.event_count as number,
    maxSeverity: row.max_severity as string,
    firstAt: new Date(row.first_at as string),
    lastAt: new Date(row.last_at as string),
    closedAt: row.closed_at ? new Date(row.closed_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapMember(row: Record<string, unknown>): StoredEventGroupMember {
  return {
    groupId: row.group_id as string,
    eventId: row.event_id as string,
    addedAt: new Date(row.added_at as string),
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

function buildLastAtCursorCondition(
  cursor: EventsCursorPosition | null,
  startParam: number,
): { clause: string; params: unknown[] } {
  if (!cursor) return { clause: "", params: [] };
  return {
    clause: ` AND (last_at, id) < ($${startParam}, $${startParam + 1})`,
    params: [cursor.occurredAt, cursor.id],
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventGroupsRepository(executor: SqlExecutor): EventGroupsRepository {
  return {
    async createGroup(input) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO events.event_groups (
             id, org_id, group_key, first_event_id, last_event_id,
             event_count, max_severity, first_at, last_at
           ) VALUES ($1, $2, $3, $4, $4, 1, $5, $6, $6)
           RETURNING *`,
          [input.id, input.orgId, input.groupKey, input.firstEventId, input.severity, input.occurredAt],
        );
        return { ok: true, value: mapGroup(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "event_group" } };
        }
        return safeError("Failed to create event group");
      }
    },

    async getOpenGroupByKey(orgId, groupKey) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.event_groups
           WHERE org_id = $1 AND group_key = $2 AND status = 'open'`,
          [orgId, groupKey],
        );
        return { ok: true, value: result.rows.length ? mapGroup(result.rows[0]!) : null };
      } catch {
        return safeError("Failed to read open event group");
      }
    },

    async getGroup(orgId, id) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.event_groups WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        return { ok: true, value: result.rows.length ? mapGroup(result.rows[0]!) : null };
      } catch {
        return safeError("Failed to read event group");
      }
    },

    async appendMember(input) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `WITH ins AS (
             INSERT INTO events.event_group_members (group_id, event_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING
             RETURNING event_id
           )
           UPDATE events.event_groups g
           SET last_event_id = CASE WHEN (SELECT count(*) FROM ins) > 0 THEN $2 ELSE g.last_event_id END,
               event_count = g.event_count + (SELECT count(*) FROM ins),
               last_at = GREATEST(g.last_at, $3::timestamptz),
               max_severity = CASE
                 WHEN array_position($5::text[], $4) > array_position($5::text[], g.max_severity)
                 THEN $4 ELSE g.max_severity
               END,
               updated_at = now()
           WHERE g.id = $1
           RETURNING *`,
          [input.groupId, input.eventId, input.occurredAt, input.severity, SEVERITY_LADDER],
        );
        return { ok: true, value: result.rows.length ? mapGroup(result.rows[0]!) : null };
      } catch {
        return safeError("Failed to append event group member");
      }
    },

    async closeGroup(orgId, id) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE events.event_groups
           SET status = 'closed', closed_at = now(), updated_at = now()
           WHERE org_id = $1 AND id = $2 AND status = 'open'
           RETURNING *`,
          [orgId, id],
        );
        return { ok: true, value: result.rows.length ? mapGroup(result.rows[0]!) : null };
      } catch {
        return safeError("Failed to close event group");
      }
    },

    async closeInactiveGroups(cutoff) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE events.event_groups
           SET status = 'closed', closed_at = now(), updated_at = now()
           WHERE status = 'open' AND last_at < $1::timestamptz
           RETURNING *`,
          [cutoff],
        );
        return { ok: true, value: result.rows.map(mapGroup) };
      } catch {
        return safeError("Failed to close inactive event groups");
      }
    },

    async listGroupsByOrg(orgId, params, status) {
      try {
        const conditions: string[] = ["org_id = $1"];
        const values: unknown[] = [orgId];
        if (status) {
          values.push(status);
          conditions.push(`status = $${values.length}`);
        }
        const cursorCondition = buildLastAtCursorCondition(params.cursor, values.length + 1);
        values.push(...cursorCondition.params);
        values.push(params.limit + 1);

        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.event_groups
           WHERE ${conditions.join(" AND ")}${cursorCondition.clause}
           ORDER BY last_at DESC, id DESC
           LIMIT $${values.length}`,
          values,
        );
        const mapped = result.rows.map(mapGroup);
        if (mapped.length > params.limit) {
          const trimmed = mapped.slice(0, params.limit);
          const last = trimmed[trimmed.length - 1]!;
          return {
            ok: true,
            value: {
              items: trimmed,
              nextCursor: { occurredAt: last.lastAt.toISOString(), id: last.id },
            },
          };
        }
        return { ok: true, value: { items: mapped, nextCursor: null } };
      } catch {
        return safeError("Failed to list event groups");
      }
    },

    async listMembers(groupId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.event_group_members
           WHERE group_id = $1
           ORDER BY added_at ASC, event_id ASC`,
          [groupId],
        );
        return { ok: true, value: result.rows.map(mapMember) };
      } catch {
        return safeError("Failed to list event group members");
      }
    },
  };
}
