import type { SqlExecutor } from "../hyperdrive/executor.js";
import type {
  AppendEventInput,
  AppendEventWithAuditInput,
  AuditOrgFilters,
  EventLogFilters,
  EventsCursorPosition,
  EventsPagedResult,
  EventsPageQueryParams,
  EventsRepository,
  EventsResult,
  StoredAuditEntry,
  StoredEvent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function parseJsonColumn(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

function parseJsonArrayColumn(value: unknown): string[] {
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  }
  if (Array.isArray(value)) return value as string[];
  return [];
}

function mapEvent(row: Record<string, unknown>): StoredEvent {
  return {
    id: row.id as string,
    type: row.type as string,
    version: row.version as number,
    source: row.source as string,
    occurredAt: new Date(row.occurred_at as string),
    actorType: row.actor_type as string,
    actorId: row.actor_id as string,
    actorSessionId: (row.actor_session_id as string) ?? null,
    actorIp: (row.actor_ip as string) ?? null,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    subjectKind: row.subject_kind as string,
    subjectId: row.subject_id as string,
    subjectName: (row.subject_name as string) ?? null,
    requestId: row.request_id as string,
    correlationId: (row.correlation_id as string) ?? null,
    causationId: (row.causation_id as string) ?? null,
    idempotencyKey: (row.idempotency_key as string) ?? null,
    payload: parseJsonColumn(row.payload),
    redactPaths: parseJsonArrayColumn(row.redact_paths),
    createdAt: new Date(row.created_at as string),
  };
}

function mapAuditEntry(row: Record<string, unknown>): StoredAuditEntry {
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    actorType: row.actor_type as string,
    actorId: row.actor_id as string,
    eventType: row.event_type as string,
    eventVersion: row.event_version as number,
    source: row.source as string,
    subjectKind: row.subject_kind as string,
    subjectId: row.subject_id as string,
    subjectName: (row.subject_name as string) ?? null,
    category: row.category as string,
    description: row.description as string,
    occurredAt: new Date(row.occurred_at as string),
    requestId: row.request_id as string,
    correlationId: (row.correlation_id as string) ?? null,
    payload: parseJsonColumn(row.payload),
    redactPaths: parseJsonArrayColumn(row.redact_paths),
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

function buildCursorCondition(cursor: EventsCursorPosition | null, startParam: number): { clause: string; params: unknown[] } {
  if (!cursor) return { clause: "", params: [] };
  return {
    clause: ` AND (occurred_at, id) < ($${startParam}, $${startParam + 1})`,
    params: [cursor.occurredAt, cursor.id],
  };
}

function extractNextCursor<T extends { occurredAt: Date; id: string }>(
  items: T[],
  limit: number,
): { trimmed: T[]; nextCursor: EventsCursorPosition | null } {
  if (items.length > limit) {
    const trimmed = items.slice(0, limit);
    const last = trimmed[trimmed.length - 1]!;
    return { trimmed, nextCursor: { occurredAt: last.occurredAt.toISOString(), id: last.id } };
  }
  return { trimmed: items, nextCursor: null };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventsRepository(executor: SqlExecutor): EventsRepository {
  return {
    async appendEvent(input: AppendEventInput): Promise<EventsResult<StoredEvent>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO events.event_log (
            id, type, version, source, occurred_at,
            actor_type, actor_id, actor_session_id, actor_ip,
            org_id, project_id, environment_id,
            subject_kind, subject_id, subject_name,
            request_id, correlation_id, causation_id, idempotency_key,
            payload, redact_paths
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12,
            $13, $14, $15,
            $16, $17, $18, $19,
            $20, $21
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING *`,
          [
            input.id,
            input.type,
            input.version,
            input.source,
            input.occurredAt.toISOString(),
            input.actorType,
            input.actorId,
            input.actorSessionId ?? null,
            input.actorIp ?? null,
            input.orgId,
            input.projectId ?? null,
            input.environmentId ?? null,
            input.subjectKind,
            input.subjectId,
            input.subjectName ?? null,
            input.requestId,
            input.correlationId ?? null,
            input.causationId ?? null,
            input.idempotencyKey ?? null,
            JSON.stringify(input.payload),
            JSON.stringify(input.redactPaths ?? []),
          ],
        );

        if (result.rows.length === 0) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }

        return { ok: true, value: mapEvent(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }
        return safeError("Failed to append event");
      }
    },

    async appendEventWithAudit(input: AppendEventWithAuditInput): Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>> {
      const { event, audit } = input;
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `WITH inserted_event AS (
            INSERT INTO events.event_log (
              id, type, version, source, occurred_at,
              actor_type, actor_id, actor_session_id, actor_ip,
              org_id, project_id, environment_id,
              subject_kind, subject_id, subject_name,
              request_id, correlation_id, causation_id, idempotency_key,
              payload, redact_paths
            ) VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, $9,
              $10, $11, $12,
              $13, $14, $15,
              $16, $17, $18, $19,
              $20, $21
            )
            ON CONFLICT (id) DO NOTHING
            RETURNING *
          ), inserted_audit AS (
            INSERT INTO events.audit_entries (
              id, event_id, org_id, project_id, environment_id,
              actor_type, actor_id,
              event_type, event_version, source,
              subject_kind, subject_id, subject_name,
              category, description, occurred_at,
              request_id, correlation_id,
              payload, redact_paths
            )
            SELECT
              $22, $1, $10, $23, $24,
              $6, $7,
              $2, $3, $4,
              $13, $14, $15,
              $25, $26, $5,
              $16, $17,
              $20, $21
            FROM inserted_event
            RETURNING *
          )
          SELECT
            row_to_json(e.*) AS _event,
            row_to_json(a.*) AS _audit
          FROM inserted_event e
          FULL JOIN inserted_audit a ON true`,
          [
            event.id,
            event.type,
            event.version,
            event.source,
            event.occurredAt.toISOString(),
            event.actorType,
            event.actorId,
            event.actorSessionId ?? null,
            event.actorIp ?? null,
            event.orgId,
            event.projectId ?? null,
            event.environmentId ?? null,
            event.subjectKind,
            event.subjectId,
            event.subjectName ?? null,
            event.requestId,
            event.correlationId ?? null,
            event.causationId ?? null,
            event.idempotencyKey ?? null,
            JSON.stringify(event.payload),
            JSON.stringify(event.redactPaths ?? []),
            audit.id,
            audit.projectId ?? event.projectId ?? null,
            audit.environmentId ?? event.environmentId ?? null,
            audit.category ?? "general",
            audit.description ?? "",
          ],
        );

        if (result.rows.length === 0) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }

        const row = result.rows[0]!;
        const eventData = typeof row._event === "string" ? JSON.parse(row._event) : row._event;
        const auditData = typeof row._audit === "string" ? JSON.parse(row._audit) : row._audit;

        if (!eventData) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }
        if (!auditData) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }

        return {
          ok: true,
          value: {
            event: mapEvent(eventData as Record<string, unknown>),
            audit: mapAuditEntry(auditData as Record<string, unknown>),
          },
        };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }
        return safeError("Failed to append event with audit");
      }
    },

    async queryAuditByOrg(orgId: string, params: EventsPageQueryParams, category?: string, filters?: AuditOrgFilters): Promise<EventsResult<EventsPagedResult<StoredAuditEntry>>> {
      try {
        // Support both raw UUID and legacy public org_ ID format.
        // Legacy membership audit rows stored org_id as "org_<hex>" instead of raw UUID.
        const legacyOrgId = `org_${orgId.replace(/-/g, "")}`;
        const baseParams: unknown[] = [orgId, legacyOrgId];
        let paramIndex = 3;

        let categoryClause = "";
        if (category) {
          categoryClause = ` AND category = $${paramIndex}`;
          baseParams.push(category);
          paramIndex++;
        }

        // Optional, independently-combinable filter clauses. Each appends a
        // parameterized `AND` predicate and advances the placeholder index;
        // none alter the ORDER BY / cursor keyset. `from`/`to` are inclusive.
        let filterClause = "";
        if (filters) {
          const eq: Array<[string, string | undefined]> = [
            ["actor_id", filters.actorId],
            ["actor_type", filters.actorType],
            ["subject_kind", filters.subjectKind],
            ["subject_id", filters.subjectId],
            ["event_type", filters.eventType],
          ];
          for (const [column, value] of eq) {
            if (value !== undefined) {
              filterClause += ` AND ${column} = $${paramIndex}`;
              baseParams.push(value);
              paramIndex++;
            }
          }
          if (filters.from !== undefined) {
            filterClause += ` AND occurred_at >= $${paramIndex}`;
            baseParams.push(filters.from);
            paramIndex++;
          }
          if (filters.to !== undefined) {
            filterClause += ` AND occurred_at <= $${paramIndex}`;
            baseParams.push(filters.to);
            paramIndex++;
          }
        }

        baseParams.push(params.limit + 1);
        const limitParam = paramIndex;
        paramIndex++;

        const { clause, params: cursorParams } = buildCursorCondition(params.cursor, paramIndex);
        const allParams = [...baseParams, ...cursorParams];

        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.audit_entries
           WHERE org_id IN ($1, $2)${categoryClause}${filterClause}${clause}
           ORDER BY occurred_at DESC, id DESC
           LIMIT $${limitParam}`,
          allParams,
        );

        const mapped = result.rows.map(mapAuditEntry);
        const { trimmed, nextCursor } = extractNextCursor(mapped, params.limit);
        return { ok: true, value: { items: trimmed, nextCursor } };
      } catch {
        return safeError("Failed to query audit by org");
      }
    },

    async queryAuditByTarget(orgId: string, subjectKind: string, subjectId: string, params: EventsPageQueryParams): Promise<EventsResult<EventsPagedResult<StoredAuditEntry>>> {
      try {
        const { clause, params: cursorParams } = buildCursorCondition(params.cursor, 5);
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.audit_entries
           WHERE org_id = $1 AND subject_kind = $2 AND subject_id = $3${clause}
           ORDER BY occurred_at DESC, id DESC
           LIMIT $4`,
          [orgId, subjectKind, subjectId, params.limit + 1, ...cursorParams],
        );

        const mapped = result.rows.map(mapAuditEntry);
        const { trimmed, nextCursor } = extractNextCursor(mapped, params.limit);
        return { ok: true, value: { items: trimmed, nextCursor } };
      } catch {
        return safeError("Failed to query audit by target");
      }
    },

    async queryEventsByOrg(orgId: string, afterOccurredAt: string | null, afterEventId: string | null, limit: number): Promise<EventsResult<StoredEvent[]>> {
      try {
        let sql: string;
        let values: unknown[];
        if (afterOccurredAt && afterEventId) {
          sql = `SELECT * FROM events.event_log
                 WHERE org_id = $1 AND (occurred_at, id) > ($2, $3)
                 ORDER BY occurred_at ASC, id ASC
                 LIMIT $4`;
          values = [orgId, afterOccurredAt, afterEventId, limit];
        } else {
          sql = `SELECT * FROM events.event_log
                 WHERE org_id = $1
                 ORDER BY occurred_at ASC, id ASC
                 LIMIT $2`;
          values = [orgId, limit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        return { ok: true, value: result.rows.map(mapEvent) };
      } catch {
        return safeError("Failed to query events by org");
      }
    },

    async listRecentlyActiveOrgIds(sinceIso: string, limit: number): Promise<EventsResult<string[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT DISTINCT org_id FROM events.event_log
           WHERE occurred_at >= $1
           LIMIT $2`,
          [sinceIso, limit],
        );
        return { ok: true, value: result.rows.map((row) => row.org_id as string) };
      } catch {
        return safeError("Failed to list recently active orgs");
      }
    },

    async getEventById(orgId: string, eventId: string): Promise<EventsResult<StoredEvent | null>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.event_log WHERE org_id = $1 AND id = $2`,
          [orgId, eventId],
        );
        if (result.rows.length === 0) {
          return { ok: true, value: null };
        }
        return { ok: true, value: mapEvent(result.rows[0]!) };
      } catch {
        return safeError("Failed to get event by id");
      }
    },

    async queryEventLogByOrg(orgId: string, params: EventsPageQueryParams, filters?: EventLogFilters): Promise<EventsResult<EventsPagedResult<StoredEvent>>> {
      try {
        const baseParams: unknown[] = [orgId];
        let paramIndex = 2;

        // Optional, independently-combinable filter clauses. Each appends a
        // parameterized `AND` predicate and advances the placeholder index; none
        // alter the ORDER BY / cursor keyset. `from`/`to` are inclusive.
        let filterClause = "";
        if (filters) {
          if (filters.type !== undefined) {
            if (filters.type.endsWith("*")) {
              // Trailing-`*` prefix glob -> LIKE 'prefix%', escaping LIKE
              // metacharacters (`%`, `_`, `\`) in the prefix so they match
              // literally.
              const prefix = filters.type.slice(0, -1).replace(/([%_\\])/g, "\\$1");
              filterClause += ` AND type LIKE $${paramIndex}`;
              baseParams.push(`${prefix}%`);
            } else {
              filterClause += ` AND type = $${paramIndex}`;
              baseParams.push(filters.type);
            }
            paramIndex++;
          }
          const eq: Array<[string, string | undefined]> = [
            ["source", filters.source],
            ["project_id", filters.projectId],
            ["environment_id", filters.environmentId],
          ];
          for (const [column, value] of eq) {
            if (value !== undefined) {
              filterClause += ` AND ${column} = $${paramIndex}`;
              baseParams.push(value);
              paramIndex++;
            }
          }
          if (filters.from !== undefined) {
            filterClause += ` AND occurred_at >= $${paramIndex}`;
            baseParams.push(filters.from);
            paramIndex++;
          }
          if (filters.to !== undefined) {
            filterClause += ` AND occurred_at <= $${paramIndex}`;
            baseParams.push(filters.to);
            paramIndex++;
          }
        }

        baseParams.push(params.limit + 1);
        const limitParam = paramIndex;
        paramIndex++;

        const { clause, params: cursorParams } = buildCursorCondition(params.cursor, paramIndex);
        const allParams = [...baseParams, ...cursorParams];

        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.event_log
           WHERE org_id = $1${filterClause}${clause}
           ORDER BY occurred_at DESC, id DESC
           LIMIT $${limitParam}`,
          allParams,
        );

        const mapped = result.rows.map(mapEvent);
        const { trimmed, nextCursor } = extractNextCursor(mapped, params.limit);
        return { ok: true, value: { items: trimmed, nextCursor } };
      } catch {
        return safeError("Failed to query event log by org");
      }
    },

    async findEventByIdempotencyKey(orgId: string, idempotencyKey: string): Promise<EventsResult<StoredEvent | null>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events.event_log
           WHERE org_id = $1 AND idempotency_key = $2
           ORDER BY occurred_at DESC
           LIMIT 1`,
          [orgId, idempotencyKey],
        );
        if (result.rows.length === 0) {
          return { ok: true, value: null };
        }
        return { ok: true, value: mapEvent(result.rows[0]!) };
      } catch {
        return safeError("Failed to find event by idempotency key");
      }
    },

    async countCustomEventsSince(orgId: string, sinceIso: string): Promise<EventsResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT count(*)::bigint AS count FROM events.event_log
           WHERE org_id = $1 AND type LIKE 'custom.%' AND occurred_at >= $2`,
          [orgId, sinceIso],
        );
        const raw = result.rows[0]?.count;
        const count = typeof raw === "number" ? raw : Number(raw ?? 0);
        return { ok: true, value: Number.isFinite(count) ? count : 0 };
      } catch {
        return safeError("Failed to count custom events");
      }
    },

    async listScmEventsSince(
      afterOccurredAt: string | null,
      afterEventId: string | null,
      limit: number,
    ): Promise<EventsResult<StoredEvent[]>> {
      try {
        // The partial index event_log_scm_ingest_idx (occurred_at, id) WHERE
        // type LIKE 'scm.%' makes this a bounded keyset scan, not a full log
        // scan — the OV4 consumer's scalability keystone.
        let sql: string;
        let values: unknown[];
        if (afterOccurredAt && afterEventId) {
          sql = `SELECT * FROM events.event_log
                 WHERE type LIKE 'scm.%' AND (occurred_at, id) > ($1, $2)
                 ORDER BY occurred_at ASC, id ASC
                 LIMIT $3`;
          values = [afterOccurredAt, afterEventId, limit];
        } else {
          sql = `SELECT * FROM events.event_log
                 WHERE type LIKE 'scm.%'
                 ORDER BY occurred_at ASC, id ASC
                 LIMIT $1`;
          values = [limit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        return { ok: true, value: result.rows.map(mapEvent) };
      } catch {
        return safeError("Failed to list scm events");
      }
    },

    async listRunResultEventsSince(
      afterOccurredAt: string | null,
      afterEventId: string | null,
      limit: number,
    ): Promise<EventsResult<StoredEvent[]>> {
      try {
        // The partial index event_log_run_result_idx (occurred_at, id) WHERE
        // type IN (the two terminal run results) makes this a bounded keyset
        // scan, not a full log scan — the OV5/IG9 driver's scalability keystone.
        let sql: string;
        let values: unknown[];
        if (afterOccurredAt && afterEventId) {
          sql = `SELECT * FROM events.event_log
                 WHERE type IN ('state.run.completed', 'state.run.failed')
                   AND (occurred_at, id) > ($1, $2)
                 ORDER BY occurred_at ASC, id ASC
                 LIMIT $3`;
          values = [afterOccurredAt, afterEventId, limit];
        } else {
          sql = `SELECT * FROM events.event_log
                 WHERE type IN ('state.run.completed', 'state.run.failed')
                 ORDER BY occurred_at ASC, id ASC
                 LIMIT $1`;
          values = [limit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        return { ok: true, value: result.rows.map(mapEvent) };
      } catch {
        return safeError("Failed to list run-result events");
      }
    },

    async deleteExpiredEvents(orgId: string, cutoffIso: string, limit: number): Promise<EventsResult<number>> {
      try {
        // Batched keyset delete backed by event_log_org_occurred_idx. Two
        // NOT EXISTS guards keep the delete FK-safe and compliant:
        //   1. design §10 security floor — an event_log row whose audit
        //      projection is category 'security' is retained regardless of age
        //      (and its audit_entries FK stays valid). Non-security audits are
        //      removed by the audit sweep first, so their log rows FK-delete
        //      cleanly here.
        //   2. group-membership guard — event_group_members.event_id references
        //      event_log(id) with NO ON DELETE CASCADE, so deleting an event
        //      still referenced by a (possibly still-open) group would raise a
        //      FK violation and abort the whole batch. Retain such rows; they
        //      age out once the closed-group sweep cascades their memberships.
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM events.event_log
           WHERE ctid IN (
             SELECT el.ctid FROM events.event_log el
             WHERE el.org_id = $1 AND el.occurred_at < $2
               AND NOT EXISTS (
                 SELECT 1 FROM events.audit_entries a
                 WHERE a.event_id = el.id AND a.category = 'security'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM events.event_group_members m
                 WHERE m.event_id = el.id
               )
             LIMIT $3
           )`,
          [orgId, cutoffIso, limit],
        );
        return { ok: true, value: result.rowCount ?? 0 };
      } catch {
        return safeError("Failed to delete expired events");
      }
    },

    async deleteExpiredAuditEntries(orgId: string, cutoffIso: string, limit: number): Promise<EventsResult<number>> {
      try {
        // The critical correctness property (ES7): security-category audit rows
        // are the compliance floor and survive regardless of age; every other
        // past-window row is deleted. category is NOT NULL so `<> 'security'`
        // never drops a NULL.
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM events.audit_entries
           WHERE ctid IN (
             SELECT ae.ctid FROM events.audit_entries ae
             WHERE ae.org_id = $1 AND ae.occurred_at < $2 AND ae.category <> 'security'
             LIMIT $3
           )`,
          [orgId, cutoffIso, limit],
        );
        return { ok: true, value: result.rowCount ?? 0 };
      } catch {
        return safeError("Failed to delete expired audit entries");
      }
    },

    async deleteExpiredDeadLetters(cutoffIso: string, limit: number): Promise<EventsResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM events.dead_letters
           WHERE ctid IN (
             SELECT dl.ctid FROM events.dead_letters dl
             WHERE dl.status IN ('replayed', 'discarded') AND dl.updated_at < $1
             LIMIT $2
           )`,
          [cutoffIso, limit],
        );
        return { ok: true, value: result.rowCount ?? 0 };
      } catch {
        return safeError("Failed to delete expired dead letters");
      }
    },

    async deleteClosedGroupsBefore(cutoffIso: string, limit: number): Promise<EventsResult<number>> {
      try {
        // event_group_members cascade via their FK to event_groups(id).
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM events.event_groups
           WHERE ctid IN (
             SELECT g.ctid FROM events.event_groups g
             WHERE g.status = 'closed' AND g.closed_at < $1
             LIMIT $2
           )`,
          [cutoffIso, limit],
        );
        return { ok: true, value: result.rowCount ?? 0 };
      } catch {
        return safeError("Failed to delete closed groups");
      }
    },
  };
}
