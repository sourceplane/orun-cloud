import type {
  ListAuditEntriesResponse,
  PublicAuditEntry,
  CustomEventInput,
  GetEventResponse,
  ListEventsResponse,
  PublicEvent,
} from "@saas/contracts/events";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Events (audit) resource client.
 *
 * Org-scoped surface served by `apps/events-worker` via the api-edge
 * `audit-facade`. Returns the immutable audit-entry projection with redacted
 * payload paths already applied server-side.
 *
 * `listAuditEntries` accepts a discriminated query object so callers can ask
 * for entries by org or by a specific subject (kind + id) — mirroring the
 * `AuditQueryByOrg` / `AuditQueryByTarget` contract shapes without having to
 * import them at the call site.
 */

/**
 * Independently-combinable filters for the org-scoped audit list. Every field
 * is optional; supplying several narrows the result set with AND semantics.
 * `from`/`to` are inclusive bounds on `occurredAt` (ISO-8601 ms Z). None of
 * these alter the keyset ordering or cursor — they only restrict eligible rows.
 */
export interface AuditEntryFilters {
  actorId?: string;
  actorType?: string;
  subjectKind?: string;
  subjectId?: string;
  eventType?: string;
  from?: string;
  to?: string;
}

export type ListAuditEntriesQuery =
  | ({
      by: "org";
      category?: string;
      limit?: number;
      cursor?: string;
    } & AuditEntryFilters)
  | {
      by: "target";
      subjectKind: string;
      subjectId: string;
      limit?: number;
      cursor?: string;
    };

/**
 * SDK-facing audit list response. The api-edge sends
 * `{ data: { auditEntries }, meta: { requestId, cursor } }` and the transport
 * unwraps to `.data`, so the SDK return type mirrors the contract's `data`
 * payload directly.
 */
export type ListAuditEntriesResult = ListAuditEntriesResponse["data"];

/**
 * Hard upper bound on pages walked by `iterAuditEntries`. A misbehaving server
 * that cycles cursors will abort with an error before this limit is reached
 * (`seenCursors` guard), but the cap is a defence-in-depth so a server that
 * returns a fresh cursor on every call cannot keep us in an infinite loop.
 *
 * Exported for tests; consumers should not rely on the exact number.
 */
export const AUDIT_ITERATOR_MAX_PAGES = 1000;

/**
 * Independently-combinable filters for the org-scoped event STREAM list
 * (`GET …/events`) — the raw event_log explorer, distinct from the audit
 * projection above. Every field is optional; supplying several narrows the
 * result set with AND semantics. `project`/`environment` accept public scope
 * ids (`prj_…` / `env_…`); `from`/`to` bound `occurredAt`. `limit`/`cursor`
 * drive keyset pagination (the cursor is opaque — pass it back verbatim).
 */
export interface EventStreamFilters {
  type?: string;
  source?: string;
  project?: string;
  environment?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Hard upper bound on pages walked by `iterEvents`. Mirrors
 * {@link AUDIT_ITERATOR_MAX_PAGES}: a `seenCursors` guard aborts a cycling
 * server first, and this cap is defence-in-depth against a server that mints a
 * fresh cursor on every call. Exported for tests.
 */
export const EVENT_ITERATOR_MAX_PAGES = 1000;

export class EventsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/audit */
  listAuditEntries(
    orgId: string,
    query: ListAuditEntriesQuery = { by: "org" },
    opts: RequestOptions = {},
  ): Promise<ListAuditEntriesResult> {
    return this.transport.request<ListAuditEntriesResult>(
      buildAuditRequest(orgId, query),
      opts,
    );
  }

  /**
   * Single-page audit fetch that also exposes the server-issued continuation
   * cursor. Use this when the caller needs the cursor for a paginated UI
   * (default `audit list` CLI mode); use `iterAuditEntries` when the caller
   * wants every entry across every page.
   *
   * `cursor` is `null` when the server has no further entries, mirroring
   * the api-edge `meta.cursor` field exactly.
   */
  async listAuditEntriesPage(
    orgId: string,
    query: ListAuditEntriesQuery = { by: "org" },
    opts: RequestOptions = {},
  ): Promise<{ entries: ReadonlyArray<PublicAuditEntry>; cursor: string | null }> {
    const { data, meta } = await this.transport.requestWithEnvelope<
      ListAuditEntriesResult
    >(buildAuditRequest(orgId, query), opts);
    return {
      entries: data.auditEntries,
      cursor: meta.cursor ?? null,
    };
  }

  /**
   * Async iterator that walks every page of audit entries until the server
   * returns `meta.cursor === null` (or `undefined`). Yields one
   * `PublicAuditEntry` at a time, in server order.
   *
   * The iterator drives `Transport.requestWithEnvelope` so it can read
   * `meta.cursor` without reaching into raw `fetchImpl`. Loop guards:
   *
   *  - hard cap of `AUDIT_ITERATOR_MAX_PAGES` page reads,
   *  - `seenCursors` Set: if the server ever returns a cursor we've already
   *    walked, the iterator throws rather than risking an infinite loop.
   *
   * Designed to be a drop-in replacement for the hand-rolled `--all` loop
   * that the CLI shipped in Task 0101 against the public `Transport`.
   */
  iterAuditEntries(
    orgId: string,
    query: ListAuditEntriesQuery = { by: "org" },
    opts: RequestOptions = {},
  ): AsyncIterable<PublicAuditEntry> {
    const transport = this.transport;
    return {
      [Symbol.asyncIterator](): AsyncIterator<PublicAuditEntry> {
        return createAuditIterator(transport, orgId, query, opts);
      },
    };
  }

  /**
   * Stream the (optionally filtered) audit log as NDJSON — one JSON-encoded
   * `PublicAuditEntry` per line, terminated by a single `\n`. Layered over
   * `iterAuditEntries`, so every filter, the keyset ordering, and the
   * `AUDIT_ITERATOR_MAX_PAGES` / `seenCursors` loop guards apply unchanged.
   *
   * Yields complete lines (including the trailing newline) so a consumer can
   * pipe them straight to stdout / a download stream without re-joining:
   *
   *   for await (const line of client.events.exportAuditEntriesNdjson(orgId, q)) {
   *     process.stdout.write(line);
   *   }
   */
  async *exportAuditEntriesNdjson(
    orgId: string,
    query: ListAuditEntriesQuery = { by: "org" },
    opts: RequestOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    for await (const entry of this.iterAuditEntries(orgId, query, opts)) {
      yield `${JSON.stringify(entry)}\n`;
    }
  }

  // -------------------------------------------------------------------------
  // Event STREAM surface (saas-event-streaming ES5) — custom ingest + the raw
  // event_log explorer. Distinct from the audit projection above: these hit
  // `POST/GET …/events` behind the api-edge events facade.
  // -------------------------------------------------------------------------

  /**
   * POST /v1/organizations/:orgId/events
   *
   * Emit a tenant-authored custom event (the `custom.*` namespace). Pass
   * `idempotencyKey` in `opts` for safe-retry semantics (mirrors
   * `NotificationsClient.enqueue`); the body may also carry an
   * `idempotencyKey` the worker uses for content-level dedupe. Returns the
   * created (or, on idempotent replay, the original) event.
   */
  emitEvent(
    orgId: string,
    body: CustomEventInput,
    opts: RequestOptions = {},
  ): Promise<GetEventResponse["data"]> {
    return this.transport.request<GetEventResponse["data"]>(
      { method: "POST", path: eventsPath(orgId), body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/events */
  listEvents(
    orgId: string,
    query: EventStreamFilters = {},
    opts: RequestOptions = {},
  ): Promise<ListEventsResponse["data"]> {
    return this.transport.request<ListEventsResponse["data"]>(
      buildEventsRequest(orgId, query),
      opts,
    );
  }

  /**
   * Single-page event fetch that also exposes the server-issued continuation
   * cursor (`meta.cursor`, `null` when exhausted). Mirrors
   * {@link listAuditEntriesPage}; use it to drive a paginated UI, and
   * {@link iterEvents} when the caller wants every event across every page.
   */
  async listEventsPage(
    orgId: string,
    query: EventStreamFilters = {},
    opts: RequestOptions = {},
  ): Promise<{ events: ReadonlyArray<PublicEvent>; cursor: string | null }> {
    const { data, meta } = await this.transport.requestWithEnvelope<
      ListEventsResponse["data"]
    >(buildEventsRequest(orgId, query), opts);
    return {
      events: data.events,
      cursor: meta.cursor ?? null,
    };
  }

  /**
   * Async iterator over every page of the event stream until the server
   * returns `meta.cursor === null`. Mirrors {@link iterAuditEntries} exactly:
   * hard cap of {@link EVENT_ITERATOR_MAX_PAGES} page reads plus a
   * `seenCursors` guard that throws rather than looping on a repeated cursor.
   */
  iterEvents(
    orgId: string,
    query: EventStreamFilters = {},
    opts: RequestOptions = {},
  ): AsyncIterable<PublicEvent> {
    const transport = this.transport;
    return {
      [Symbol.asyncIterator](): AsyncIterator<PublicEvent> {
        return createEventIterator(transport, orgId, query, opts);
      },
    };
  }

  /**
   * Stream the (optionally filtered) event log as NDJSON — one JSON-encoded
   * `PublicEvent` per line, terminated by `\n`. Layered over
   * {@link iterEvents}, so all filters and loop guards apply unchanged.
   */
  async *exportEventsNdjson(
    orgId: string,
    query: EventStreamFilters = {},
    opts: RequestOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    for await (const event of this.iterEvents(orgId, query, opts)) {
      yield `${JSON.stringify(event)}\n`;
    }
  }

  /** GET /v1/organizations/:orgId/events/:eventId */
  getEvent(
    orgId: string,
    eventId: string,
    opts: RequestOptions = {},
  ): Promise<GetEventResponse["data"]> {
    return this.transport.request<GetEventResponse["data"]>(
      {
        method: "GET",
        path: `${eventsPath(orgId)}/${encodeURIComponent(eventId)}`,
      },
      opts,
    );
  }
}

interface AuditRequestInput {
  method: "GET";
  path: string;
  query: Record<string, string | number | undefined>;
}

function buildAuditRequest(
  orgId: string,
  query: ListAuditEntriesQuery,
): AuditRequestInput {
  const params: Record<string, string | number | undefined> = {};
  if (query.limit !== undefined) params.limit = query.limit;
  if (query.cursor !== undefined) params.cursor = query.cursor;
  if (query.by === "org") {
    if (query.category !== undefined) params.category = query.category;
    if (query.actorId !== undefined) params.actorId = query.actorId;
    if (query.actorType !== undefined) params.actorType = query.actorType;
    if (query.subjectKind !== undefined) params.subjectKind = query.subjectKind;
    if (query.subjectId !== undefined) params.subjectId = query.subjectId;
    if (query.eventType !== undefined) params.eventType = query.eventType;
    if (query.from !== undefined) params.from = query.from;
    if (query.to !== undefined) params.to = query.to;
  } else {
    params.subjectKind = query.subjectKind;
    params.subjectId = query.subjectId;
  }
  return {
    method: "GET",
    path: `/v1/organizations/${encodeURIComponent(orgId)}/audit`,
    query: params,
  };
}

function createAuditIterator(
  transport: Transport,
  orgId: string,
  initialQuery: ListAuditEntriesQuery,
  opts: RequestOptions,
): AsyncIterator<PublicAuditEntry> {
  let bufferedEntries: PublicAuditEntry[] = [];
  let bufferIndex = 0;
  let nextCursor: string | undefined = initialQuery.cursor;
  let pagesRead = 0;
  let exhausted = false;
  const seenCursors = new Set<string>();

  return {
    async next(): Promise<IteratorResult<PublicAuditEntry>> {
      while (true) {
        if (bufferIndex < bufferedEntries.length) {
          const value = bufferedEntries[bufferIndex] as PublicAuditEntry;
          bufferIndex += 1;
          return { value, done: false };
        }
        if (exhausted) {
          return { value: undefined, done: true };
        }
        if (pagesRead >= AUDIT_ITERATOR_MAX_PAGES) {
          throw new Error(
            `audit iterator exceeded ${AUDIT_ITERATOR_MAX_PAGES} page reads — refusing to continue`,
          );
        }

        const queryForPage: ListAuditEntriesQuery =
          initialQuery.by === "org"
            ? {
                by: "org",
                ...(initialQuery.category !== undefined
                  ? { category: initialQuery.category }
                  : {}),
                ...(initialQuery.actorId !== undefined
                  ? { actorId: initialQuery.actorId }
                  : {}),
                ...(initialQuery.actorType !== undefined
                  ? { actorType: initialQuery.actorType }
                  : {}),
                ...(initialQuery.subjectKind !== undefined
                  ? { subjectKind: initialQuery.subjectKind }
                  : {}),
                ...(initialQuery.subjectId !== undefined
                  ? { subjectId: initialQuery.subjectId }
                  : {}),
                ...(initialQuery.eventType !== undefined
                  ? { eventType: initialQuery.eventType }
                  : {}),
                ...(initialQuery.from !== undefined
                  ? { from: initialQuery.from }
                  : {}),
                ...(initialQuery.to !== undefined
                  ? { to: initialQuery.to }
                  : {}),
                ...(initialQuery.limit !== undefined
                  ? { limit: initialQuery.limit }
                  : {}),
                ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
              }
            : {
                by: "target",
                subjectKind: initialQuery.subjectKind,
                subjectId: initialQuery.subjectId,
                ...(initialQuery.limit !== undefined
                  ? { limit: initialQuery.limit }
                  : {}),
                ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
              };

        const { data, meta } = await transport.requestWithEnvelope<
          ListAuditEntriesResult
        >(buildAuditRequest(orgId, queryForPage), opts);
        pagesRead += 1;

        bufferedEntries = data.auditEntries.slice();
        bufferIndex = 0;

        const cursor = meta.cursor;
        if (cursor === null || cursor === undefined) {
          exhausted = true;
          nextCursor = undefined;
        } else {
          if (seenCursors.has(cursor)) {
            throw new Error(
              `audit iterator detected a repeated cursor (${cursor}); aborting to avoid an infinite loop`,
            );
          }
          seenCursors.add(cursor);
          nextCursor = cursor;
        }
      }
    },
  };
}

/** Org-scoped events collection path (`…/events`), org id URL-encoded. */
function eventsPath(orgId: string): string {
  return `/v1/organizations/${encodeURIComponent(orgId)}/events`;
}

interface EventsRequestInput {
  method: "GET";
  path: string;
  query: Record<string, string | number | undefined>;
}

/**
 * Build the GET request for the event-stream list, threading the optional
 * filter/pagination params (omitting `undefined` so the URL builder never
 * emits an empty `key=`). Shared by `listEvents`, `listEventsPage`, and the
 * iterator so the wire shape stays in lock-step.
 */
function buildEventsRequest(
  orgId: string,
  query: EventStreamFilters,
): EventsRequestInput {
  const params: Record<string, string | number | undefined> = {};
  if (query.type !== undefined) params.type = query.type;
  if (query.source !== undefined) params.source = query.source;
  if (query.project !== undefined) params.project = query.project;
  if (query.environment !== undefined) params.environment = query.environment;
  if (query.from !== undefined) params.from = query.from;
  if (query.to !== undefined) params.to = query.to;
  if (query.limit !== undefined) params.limit = query.limit;
  if (query.cursor !== undefined) params.cursor = query.cursor;
  return {
    method: "GET",
    path: eventsPath(orgId),
    query: params,
  };
}

function createEventIterator(
  transport: Transport,
  orgId: string,
  initialQuery: EventStreamFilters,
  opts: RequestOptions,
): AsyncIterator<PublicEvent> {
  let bufferedEvents: PublicEvent[] = [];
  let bufferIndex = 0;
  let nextCursor: string | undefined = initialQuery.cursor;
  let pagesRead = 0;
  let exhausted = false;
  const seenCursors = new Set<string>();

  return {
    async next(): Promise<IteratorResult<PublicEvent>> {
      while (true) {
        if (bufferIndex < bufferedEvents.length) {
          const value = bufferedEvents[bufferIndex] as PublicEvent;
          bufferIndex += 1;
          return { value, done: false };
        }
        if (exhausted) {
          return { value: undefined, done: true };
        }
        if (pagesRead >= EVENT_ITERATOR_MAX_PAGES) {
          throw new Error(
            `event iterator exceeded ${EVENT_ITERATOR_MAX_PAGES} page reads — refusing to continue`,
          );
        }

        const queryForPage: EventStreamFilters = {
          ...initialQuery,
          ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        };

        const { data, meta } = await transport.requestWithEnvelope<
          ListEventsResponse["data"]
        >(buildEventsRequest(orgId, queryForPage), opts);
        pagesRead += 1;

        bufferedEvents = data.events.slice();
        bufferIndex = 0;

        const cursor = meta.cursor;
        if (cursor === null || cursor === undefined) {
          exhausted = true;
          nextCursor = undefined;
        } else {
          if (seenCursors.has(cursor)) {
            throw new Error(
              `event iterator detected a repeated cursor (${cursor}); aborting to avoid an infinite loop`,
            );
          }
          seenCursors.add(cursor);
          nextCursor = cursor;
        }
      }
    },
  };
}
