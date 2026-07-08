import type {
  DeadLetterStatus,
  ListDeadLettersResponse,
  PublicDeadLetter,
  ReplayDeadLetterResponse,
} from "@saas/contracts/events";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Dead Letters resource client (saas-event-streaming ES1 ops surface).
 *
 * Org-scoped list + replay for events that a lane failed to deliver, served by
 * `apps/events-worker` via the api-edge `dead-letters-facade`. Authorization
 * (`dead_letter.read` / `dead_letter.replay`) happens in events-worker via
 * policy — the facade only authenticates and forwards.
 *
 * There is deliberately no `discard`: the ES1 surface exposes list + replay
 * only (a letter reaches `discarded` through internal lifecycle, never a public
 * mutation).
 */

/**
 * Cursor-pagination query for the dead-letters list. Every field is optional
 * and maps 1:1 to the query params the events-worker reads: an optional
 * `status` (`open` | `replayed` | `discarded`) plus `limit` and the opaque
 * continuation `cursor` (surfaced on the previous page's `meta.cursor` — pass
 * it back verbatim, never construct or parse it).
 */
export interface ListDeadLettersQuery {
  status?: DeadLetterStatus;
  limit?: number;
  cursor?: string;
}

export class DeadLettersClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/dead-letters */
  list(
    orgId: string,
    query: ListDeadLettersQuery = {},
    opts: RequestOptions = {},
  ): Promise<ListDeadLettersResponse["data"]> {
    return this.transport.request<ListDeadLettersResponse["data"]>(
      buildDeadLettersRequest(orgId, query),
      opts,
    );
  }

  /**
   * Single-page dead-letters fetch that also exposes the server-issued
   * continuation cursor (`meta.cursor`, `null` when exhausted). Use it to drive
   * a paginated UI.
   */
  async listPage(
    orgId: string,
    query: ListDeadLettersQuery = {},
    opts: RequestOptions = {},
  ): Promise<{ deadLetters: ReadonlyArray<PublicDeadLetter>; cursor: string | null }> {
    const { data, meta } = await this.transport.requestWithEnvelope<
      ListDeadLettersResponse["data"]
    >(buildDeadLettersRequest(orgId, query), opts);
    return {
      deadLetters: data.deadLetters,
      cursor: meta.cursor ?? null,
    };
  }

  /**
   * POST /v1/organizations/:orgId/dead-letters/:deadLetterId/replay
   *
   * Re-run the lane handler for the source event. Succeeds only when the letter
   * is still `open`; returns the letter with its updated `status`.
   */
  replay(
    orgId: string,
    deadLetterId: string,
    opts: RequestOptions = {},
  ): Promise<ReplayDeadLetterResponse["data"]> {
    return this.transport.request<ReplayDeadLetterResponse["data"]>(
      {
        method: "POST",
        path: `${deadLettersPath(orgId)}/${encodeURIComponent(deadLetterId)}/replay`,
      },
      opts,
    );
  }
}

/** Org-scoped dead-letters collection path, org id URL-encoded. */
function deadLettersPath(orgId: string): string {
  return `/v1/organizations/${encodeURIComponent(orgId)}/dead-letters`;
}

interface DeadLettersRequestInput {
  method: "GET";
  path: string;
  query: Record<string, string | number | undefined>;
}

function buildDeadLettersRequest(
  orgId: string,
  query: ListDeadLettersQuery,
): DeadLettersRequestInput {
  const params: Record<string, string | number | undefined> = {};
  if (query.status !== undefined) params.status = query.status;
  if (query.limit !== undefined) params.limit = query.limit;
  if (query.cursor !== undefined) params.cursor = query.cursor;
  return {
    method: "GET",
    path: deadLettersPath(orgId),
    query: params,
  };
}
