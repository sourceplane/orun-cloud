import type {
  GetEventGroupResponse,
  ListEventGroupsResponse,
  PublicEventGroup,
} from "@saas/contracts/events";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Event Groups resource client (saas-event-streaming ES4).
 *
 * Org-scoped, read-only dedup/correlation "stories" served by
 * `apps/events-worker` via the api-edge `event-groups-facade`. Same viewer+
 * policy as the event stream (`organization.event.read`); the config secret
 * never surfaces here.
 *
 * Mirrors the small read-client shape (see {@link SecurityEventsClient}) plus
 * the audit-style `iter` walk over the keyset cursor.
 */

/**
 * Cursor-pagination query for the event-groups list. Every field is optional
 * and maps 1:1 to the query params the events-worker reads: an optional
 * `status` (`open` | `closed`) plus `limit` and the opaque continuation
 * `cursor` (surfaced on the previous page's `meta.cursor` — pass it back
 * verbatim, never construct or parse it).
 */
export interface ListEventGroupsQuery {
  status?: "open" | "closed";
  limit?: number;
  cursor?: string;
}

/**
 * Hard upper bound on pages walked by `iter`. Mirrors the event/audit
 * iterators: a `seenCursors` guard aborts a cycling server first, and this cap
 * is defence-in-depth. Exported for tests.
 */
export const EVENT_GROUP_ITERATOR_MAX_PAGES = 1000;

export class EventGroupsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/event-groups */
  list(
    orgId: string,
    query: ListEventGroupsQuery = {},
    opts: RequestOptions = {},
  ): Promise<ListEventGroupsResponse["data"]> {
    return this.transport.request<ListEventGroupsResponse["data"]>(
      buildEventGroupsRequest(orgId, query),
      opts,
    );
  }

  /**
   * Single-page event-groups fetch that also exposes the server-issued
   * continuation cursor (`meta.cursor`, `null` when exhausted). Use it to
   * drive a paginated UI; use {@link iter} to walk every page.
   */
  async listPage(
    orgId: string,
    query: ListEventGroupsQuery = {},
    opts: RequestOptions = {},
  ): Promise<{ eventGroups: ReadonlyArray<PublicEventGroup>; cursor: string | null }> {
    const { data, meta } = await this.transport.requestWithEnvelope<
      ListEventGroupsResponse["data"]
    >(buildEventGroupsRequest(orgId, query), opts);
    return {
      eventGroups: data.eventGroups,
      cursor: meta.cursor ?? null,
    };
  }

  /**
   * Async iterator over every page of event groups until the server returns
   * `meta.cursor === null`. Hard cap of {@link EVENT_GROUP_ITERATOR_MAX_PAGES}
   * page reads plus a `seenCursors` guard that throws on a repeated cursor
   * rather than looping.
   */
  iter(
    orgId: string,
    query: ListEventGroupsQuery = {},
    opts: RequestOptions = {},
  ): AsyncIterable<PublicEventGroup> {
    const transport = this.transport;
    return {
      [Symbol.asyncIterator](): AsyncIterator<PublicEventGroup> {
        return createEventGroupIterator(transport, orgId, query, opts);
      },
    };
  }

  /** GET /v1/organizations/:orgId/event-groups/:groupId */
  get(
    orgId: string,
    groupId: string,
    opts: RequestOptions = {},
  ): Promise<GetEventGroupResponse["data"]> {
    return this.transport.request<GetEventGroupResponse["data"]>(
      {
        method: "GET",
        path: `${eventGroupsPath(orgId)}/${encodeURIComponent(groupId)}`,
      },
      opts,
    );
  }
}

/** Org-scoped event-groups collection path, org id URL-encoded. */
function eventGroupsPath(orgId: string): string {
  return `/v1/organizations/${encodeURIComponent(orgId)}/event-groups`;
}

interface EventGroupsRequestInput {
  method: "GET";
  path: string;
  query: Record<string, string | number | undefined>;
}

function buildEventGroupsRequest(
  orgId: string,
  query: ListEventGroupsQuery,
): EventGroupsRequestInput {
  const params: Record<string, string | number | undefined> = {};
  if (query.status !== undefined) params.status = query.status;
  if (query.limit !== undefined) params.limit = query.limit;
  if (query.cursor !== undefined) params.cursor = query.cursor;
  return {
    method: "GET",
    path: eventGroupsPath(orgId),
    query: params,
  };
}

function createEventGroupIterator(
  transport: Transport,
  orgId: string,
  initialQuery: ListEventGroupsQuery,
  opts: RequestOptions,
): AsyncIterator<PublicEventGroup> {
  let buffered: PublicEventGroup[] = [];
  let bufferIndex = 0;
  let nextCursor: string | undefined = initialQuery.cursor;
  let pagesRead = 0;
  let exhausted = false;
  const seenCursors = new Set<string>();

  return {
    async next(): Promise<IteratorResult<PublicEventGroup>> {
      while (true) {
        if (bufferIndex < buffered.length) {
          const value = buffered[bufferIndex] as PublicEventGroup;
          bufferIndex += 1;
          return { value, done: false };
        }
        if (exhausted) {
          return { value: undefined, done: true };
        }
        if (pagesRead >= EVENT_GROUP_ITERATOR_MAX_PAGES) {
          throw new Error(
            `event-group iterator exceeded ${EVENT_GROUP_ITERATOR_MAX_PAGES} page reads — refusing to continue`,
          );
        }

        const queryForPage: ListEventGroupsQuery = {
          ...initialQuery,
          ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        };

        const { data, meta } = await transport.requestWithEnvelope<
          ListEventGroupsResponse["data"]
        >(buildEventGroupsRequest(orgId, queryForPage), opts);
        pagesRead += 1;

        buffered = data.eventGroups.slice();
        bufferIndex = 0;

        const cursor = meta.cursor;
        if (cursor === null || cursor === undefined) {
          exhausted = true;
          nextCursor = undefined;
        } else {
          if (seenCursors.has(cursor)) {
            throw new Error(
              `event-group iterator detected a repeated cursor (${cursor}); aborting to avoid an infinite loop`,
            );
          }
          seenCursors.add(cursor);
          nextCursor = cursor;
        }
      }
    },
  };
}
