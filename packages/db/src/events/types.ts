export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type EventsRepositoryError =
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type EventsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EventsRepositoryError };

// ---------------------------------------------------------------------------
// Domain entities (mapped from DB rows)
// ---------------------------------------------------------------------------

export interface StoredEvent {
  id: string;
  type: string;
  version: number;
  source: string;
  occurredAt: Date;
  actorType: string;
  actorId: string;
  actorSessionId: string | null;
  actorIp: string | null;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  subjectKind: string;
  subjectId: string;
  subjectName: string | null;
  requestId: string;
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  redactPaths: string[];
  createdAt: Date;
}

export interface StoredAuditEntry {
  id: string;
  eventId: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  actorType: string;
  actorId: string;
  eventType: string;
  eventVersion: number;
  source: string;
  subjectKind: string;
  subjectId: string;
  subjectName: string | null;
  category: string;
  description: string;
  occurredAt: Date;
  requestId: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
  redactPaths: string[];
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AppendEventInput {
  id: string;
  type: string;
  version: number;
  source: string;
  occurredAt: Date;
  actorType: string;
  actorId: string;
  actorSessionId?: string | null;
  actorIp?: string | null;
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
  subjectKind: string;
  subjectId: string;
  subjectName?: string | null;
  requestId: string;
  correlationId?: string | null;
  causationId?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
  redactPaths?: string[];
}

export interface AppendAuditInput {
  id: string;
  eventId: string;
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
  actorType: string;
  actorId: string;
  eventType: string;
  eventVersion: number;
  source: string;
  subjectKind: string;
  subjectId: string;
  subjectName?: string | null;
  category?: string;
  description?: string;
  occurredAt: Date;
  requestId: string;
  correlationId?: string | null;
  payload: Record<string, unknown>;
  redactPaths?: string[];
}

export interface AppendEventWithAuditInput {
  event: AppendEventInput;
  audit: Omit<AppendAuditInput, "eventId" | "orgId" | "actorType" | "actorId" | "eventType" | "eventVersion" | "source" | "subjectKind" | "subjectId" | "subjectName" | "occurredAt" | "requestId" | "correlationId" | "payload" | "redactPaths"> & {
    id: string;
    category?: string;
    description?: string;
    projectId?: string | null;
    environmentId?: string | null;
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface EventsCursorPosition {
  occurredAt: string;
  id: string;
}

export interface EventsPageQueryParams {
  limit: number;
  cursor: EventsCursorPosition | null;
}

export interface EventsPagedResult<T> {
  items: T[];
  nextCursor: EventsCursorPosition | null;
}

/**
 * Optional, independently-combinable filters for the org-scoped audit read.
 *
 * Each field narrows the result set with an additional `AND` clause; omitting
 * a field (or passing `undefined`) leaves that dimension unfiltered. `from` /
 * `to` are inclusive ISO-8601 timestamps bounding `occurred_at`. None of these
 * change the `ORDER BY occurred_at DESC, id DESC` keyset ordering or the cursor
 * semantics — they only restrict which rows are eligible.
 */
export interface AuditOrgFilters {
  actorId?: string;
  actorType?: string;
  subjectKind?: string;
  subjectId?: string;
  eventType?: string;
  from?: string;
  to?: string;
}

/**
 * Optional, independently-combinable filters for the org-scoped event-log read
 * (the ES5 explorer). Same `AND`-composition and inclusive `from`/`to` bounds
 * as {@link AuditOrgFilters}. `type` is exact-match OR a trailing-`*` prefix glob
 * (`custom.*` -> SQL `type LIKE 'custom.%'`); every other field is exact match.
 * `projectId`/`environmentId` are the internal UUIDs (the handler converts the
 * caller's public ids before calling).
 */
export interface EventLogFilters {
  type?: string;
  source?: string;
  projectId?: string;
  environmentId?: string;
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface EventsRepository {
  appendEvent(input: AppendEventInput): Promise<EventsResult<StoredEvent>>;
  appendEventWithAudit(input: AppendEventWithAuditInput): Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>>;
  queryAuditByOrg(orgId: string, params: EventsPageQueryParams, category?: string, filters?: AuditOrgFilters): Promise<EventsResult<EventsPagedResult<StoredAuditEntry>>>;
  queryAuditByTarget(orgId: string, subjectKind: string, subjectId: string, params: EventsPageQueryParams): Promise<EventsResult<EventsPagedResult<StoredAuditEntry>>>;
  /** Query events for an org after a cursor position (for webhook dispatch fanout). */
  queryEventsByOrg(orgId: string, afterOccurredAt: string | null, afterEventId: string | null, limit: number): Promise<EventsResult<StoredEvent[]>>;
  /**
   * Distinct org ids with at least one event on/after `sinceIso` — the
   * grouping lane's org discovery (ES4). Recency-bounded so it does not scan
   * the whole log; backed by the `(org_id, occurred_at DESC, id DESC)` index.
   */
  listRecentlyActiveOrgIds(sinceIso: string, limit: number): Promise<EventsResult<string[]>>;
  /**
   * Read a single org-scoped event by id. Returns `null` (not an error) when no
   * row matches — callers distinguish "absent" from "infra failure" without a
   * dedicated `not_found` error kind. Used by the webhooks manual-replay path to
   * rehydrate the full original event payload by id.
   */
  getEventById(orgId: string, eventId: string): Promise<EventsResult<StoredEvent | null>>;
  /**
   * Org-scoped, time-ordered keyset scan of the raw event_log (the ES5 explorer
   * read). Same `ORDER BY occurred_at DESC, id DESC` keyset and `limit+1`
   * next-cursor computation as {@link queryAuditByOrg}, but reads `events.event_log`
   * and maps to {@link StoredEvent}. `filters` compose as parameterized `AND`
   * clauses; `type` supports a trailing-`*` prefix glob.
   */
  queryEventLogByOrg(orgId: string, params: EventsPageQueryParams, filters?: EventLogFilters): Promise<EventsResult<EventsPagedResult<StoredEvent>>>;
  /**
   * The most recent org-scoped event carrying `idempotencyKey`, or `null` when
   * none exists — the ES5 ingest idempotent-replay lookup. Returns `null` (not an
   * error) on no match, mirroring {@link getEventById}.
   */
  findEventByIdempotencyKey(orgId: string, idempotencyKey: string): Promise<EventsResult<StoredEvent | null>>;
  /**
   * Count of tenant-authored custom events (`type LIKE 'custom.%'`) for an org
   * on/after `sinceIso` — the ES5 per-day quota check. Bounded by the
   * `(org_id, occurred_at DESC, id DESC)` index for a recency window.
   */
  countCustomEventsSince(orgId: string, sinceIso: string): Promise<EventsResult<number>>;
  /**
   * Global, time-ordered keyset scan of source-control events (`type LIKE
   * 'scm.%'`) strictly after the cursor — the OV4 state-worker bridge consumer's
   * drain query. Backed by the partial index event_log_scm_ingest_idx, so per
   * call is O(limit) regardless of total event volume.
   */
  listScmEventsSince(
    afterOccurredAt: string | null,
    afterEventId: string | null,
    limit: number,
  ): Promise<EventsResult<StoredEvent[]>>;
  /**
   * Global, time-ordered keyset scan of TERMINAL run events (`type IN
   * ('state.run.completed', 'state.run.failed')`) strictly after the cursor —
   * the OV5/IG9 state-worker write-back driver's drain query. Backed by the
   * partial index event_log_run_result_idx, so per call is O(limit) regardless
   * of total event volume.
   */
  listRunResultEventsSince(
    afterOccurredAt: string | null,
    afterEventId: string | null,
    limit: number,
  ): Promise<EventsResult<StoredEvent[]>>;

  // -------------------------------------------------------------------------
  // Retention sweep (saas-event-streaming ES7). Each delete is a single
  // batched keyset scan (ctid-in-subquery with a LIMIT) returning the number
  // of rows removed, so the caller loops until a batch drains or a per-tick cap
  // is hit. Bounded work per call regardless of backlog.
  // -------------------------------------------------------------------------
  /**
   * Delete up to `limit` `events.event_log` rows for the org with
   * `occurred_at < cutoffIso`, EXCEPT rows whose audit projection is
   * `category = 'security'` — the design §10 security floor keeps the raw log
   * behind a retained security audit (and keeps the audit_entries FK valid).
   * Returns the number of rows deleted.
   */
  deleteExpiredEvents(orgId: string, cutoffIso: string, limit: number): Promise<EventsResult<number>>;
  /**
   * Delete up to `limit` `events.audit_entries` rows for the org with
   * `occurred_at < cutoffIso` EXCEPT `category = 'security'` rows — the design
   * §10 compliance floor: security audit records are retained regardless of
   * plan age. Returns the number of rows deleted.
   */
  deleteExpiredAuditEntries(orgId: string, cutoffIso: string, limit: number): Promise<EventsResult<number>>;
  /**
   * Delete up to `limit` terminal-status (`replayed`/`discarded`) dead letters
   * across ALL orgs whose `updated_at < cutoffIso` — the fixed platform-window
   * dead-letter sweep. Open dead letters are never aged out. Returns the count.
   */
  deleteExpiredDeadLetters(cutoffIso: string, limit: number): Promise<EventsResult<number>>;
  /**
   * Delete up to `limit` closed `events.event_groups` across ALL orgs whose
   * `closed_at < cutoffIso` — the fixed platform-window closed-group sweep.
   * Members cascade via the `event_group_members` FK. Returns the count.
   */
  deleteClosedGroupsBefore(cutoffIso: string, limit: number): Promise<EventsResult<number>>;
}
