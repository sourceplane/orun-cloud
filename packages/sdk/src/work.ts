// Work client (orun-work v2 WP1) — the work lens over the edge.
//
// Reads return the fold's output (rungs WITH evidence, recomputed on every
// request); there is deliberately no setStatus method — lifecycle is a
// derived query (WP-3). Writes are coordination-log mutations; a rejected
// mutation surfaces as a typed OrunCloudError carrying the mutator's verdict.

import type {
  IngestWorkObservationRequest,
  IngestWorkObservationResponse,
  CreateWorkInitiativeRequest,
  CreateWorkInitiativeResponse,
  CreateWorkSpecRequest,
  CreateWorkSpecResponse,
  CreateWorkTaskRequest,
  CreateWorkTaskResponse,
  EditWorkItemRequest,
  GetWorkDocResponse,
  ListWorkEventsResponse,
  PutWorkDocRequest,
  PutWorkDocResponse,
  WorkDocHistoryResponse,
  WorkAssignRequest,
  WorkCommentRequest,
  WorkContractRequest,
  WorkEventView,
  WorkImportRequest,
  WorkImportResponse,
  WorkMutationResponse,
  WorkPinRequest,
  WorkSummaryResponse,
} from "@saas/contracts/work";

import type { Transport, RequestOptions } from "./transport.js";

function workBase(orgId: string): string {
  return `/v1/organizations/${encodeURIComponent(orgId)}/work`;
}

/** Parses one SSE frame; only `event: work` frames carry an event view.
 *  Comments (`: ka`) and `retry:` hints return null. Exported for tests. */
export function parseWorkFrame(frame: string): WorkEventView | null {
  let isWork = false;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) isWork = line.slice(6).trim() === "work";
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!isWork || dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as WorkEventView;
  } catch {
    return null;
  }
}

export class WorkClient {
  constructor(private readonly transport: Transport) {}

  /** The whole workspace lens: specs with progress, tasks with derived
   *  lifecycle + evidence, the drift inbox, and claim suggestions. */
  summary(orgId: string, opts: RequestOptions = {}): Promise<WorkSummaryResponse> {
    return this.transport.request<WorkSummaryResponse>(
      { method: "GET", path: workBase(orgId) },
      opts,
    );
  }

  /** Coordination-log page from a seq cursor (the activity feed / replay). */
  listEvents(orgId: string, fromSeq = 0, opts: RequestOptions = {}): Promise<ListWorkEventsResponse> {
    return this.transport.request<ListWorkEventsResponse>(
      { method: "GET", path: `${workBase(orgId)}/events`, query: { from: fromSeq || undefined } },
      opts,
    );
  }

  /**
   * Live coordination-log tail over server-sent events — the same events, the
   * same `from` cursor as `listEvents`, pushed instead of polled. Yields each
   * event as it arrives and RETURNS when the server closes its (deliberately
   * bounded) stream; callers reconnect in a loop with the last yielded seq:
   *
   *   let from = summary.coordSeq;
   *   for (;;) {
   *     for await (const e of client.work.streamEvents(orgId, from, { signal })) {
   *       from = e.seq; onEvent(e);
   *     }
   *   }
   *
   * Abort via `opts.signal` to stop. Throws a typed OrunCloudError when the
   * initial request is rejected (so a 404/403 does NOT silently retry).
   */
  async *streamEvents(orgId: string, fromSeq = 0, opts: RequestOptions = {}): AsyncGenerator<WorkEventView, void, void> {
    const response = await this.transport.requestStream(
      { method: "GET", path: `${workBase(orgId)}/events/stream`, query: { from: fromSeq || undefined } },
      opts,
    );
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; the tail stays buffered.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const view = parseWorkFrame(frame);
          if (view) yield view;
        }
      }
    } finally {
      // Releases the connection on abort/early break as well as normal end.
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    }
  }

  createSpec(orgId: string, body: CreateWorkSpecRequest, opts: RequestOptions = {}): Promise<CreateWorkSpecResponse> {
    return this.transport.request<CreateWorkSpecResponse>(
      { method: "POST", path: `${workBase(orgId)}/specs`, body },
      opts,
    );
  }

  createTask(orgId: string, body: CreateWorkTaskRequest, opts: RequestOptions = {}): Promise<CreateWorkTaskResponse> {
    return this.transport.request<CreateWorkTaskResponse>(
      { method: "POST", path: `${workBase(orgId)}/tasks`, body },
      opts,
    );
  }

  /** v3 PM0: a strategic grouping — envelope-only, no contract, no rung. */
  createInitiative(orgId: string, body: CreateWorkInitiativeRequest, opts: RequestOptions = {}): Promise<CreateWorkInitiativeResponse> {
    return this.transport.request<CreateWorkInitiativeResponse>(
      { method: "POST", path: `${workBase(orgId)}/initiatives`, body },
      opts,
    );
  }

  /** v3 PM0: edit an item's envelope (title/description/labels) — intent
   *  only; there is deliberately no way to write a rung here. */
  editItem(orgId: string, key: string, body: EditWorkItemRequest, opts: RequestOptions = {}): Promise<WorkMutationResponse> {
    return this.transport.request<WorkMutationResponse>(
      { method: "POST", path: `${workBase(orgId)}/items/${encodeURIComponent(key)}/edit`, body },
      opts,
    );
  }

  /** v3 PM0: save a cloud document revision (content-addressed; an identical
   *  body is a no-op — created:false, no event). Fork-visible LWW. */
  putDoc(orgId: string, specKey: string, body: PutWorkDocRequest, opts: RequestOptions = {}): Promise<PutWorkDocResponse> {
    return this.transport.request<PutWorkDocResponse>(
      { method: "PUT", path: `${workBase(orgId)}/specs/${encodeURIComponent(specKey)}/doc`, body },
      opts,
    );
  }

  /** v3 PM0: read a document revision (latest when rev is omitted). 404s
   *  with a typed error when the doc_ref points at a repo-imported body the
   *  cloud never stored — render "imported from repo @ digest". */
  getDoc(orgId: string, specKey: string, rev?: string, opts: RequestOptions = {}): Promise<GetWorkDocResponse> {
    return this.transport.request<GetWorkDocResponse>(
      { method: "GET", path: `${workBase(orgId)}/specs/${encodeURIComponent(specKey)}/doc`, query: { rev } },
      opts,
    );
  }

  /** v3 PM0: the revision chain, oldest first; forks are visible. */
  docHistory(orgId: string, specKey: string, opts: RequestOptions = {}): Promise<WorkDocHistoryResponse> {
    return this.transport.request<WorkDocHistoryResponse>(
      { method: "GET", path: `${workBase(orgId)}/specs/${encodeURIComponent(specKey)}/doc/history` },
      opts,
    );
  }

  comment(orgId: string, key: string, body: WorkCommentRequest, opts: RequestOptions = {}): Promise<WorkMutationResponse> {
    return this.taskAction(orgId, key, "comment", body, opts);
  }

  assign(orgId: string, key: string, body: WorkAssignRequest, opts: RequestOptions = {}): Promise<WorkMutationResponse> {
    return this.taskAction(orgId, key, "assign", body, opts);
  }

  /** Pins are public, attributed overrides rendered beside observed truth;
   *  the mutator rejects agent actors (WP-10). rung null unpins. */
  pin(orgId: string, key: string, body: WorkPinRequest, opts: RequestOptions = {}): Promise<WorkMutationResponse> {
    return this.taskAction(orgId, key, "pin", body, opts);
  }

  cancel(orgId: string, key: string, opts: RequestOptions = {}): Promise<WorkMutationResponse> {
    return this.taskAction(orgId, key, "cancel", {}, opts);
  }

  editContract(orgId: string, key: string, body: WorkContractRequest, opts: RequestOptions = {}): Promise<WorkMutationResponse> {
    return this.taskAction(orgId, key, "contract", body, opts);
  }

  /** Posts a world-authored fact from the "ci" producer (the affected-set
   *  feed: a CI run attaches Result.Affected to a PR observation). Idempotent
   *  by dedupeKey. */
  ingestObservation(orgId: string, body: IngestWorkObservationRequest, opts: RequestOptions = {}): Promise<IngestWorkObservationResponse> {
    return this.transport.request<IngestWorkObservationResponse>(
      { method: "POST", path: `${workBase(orgId)}/observations`, body },
      opts,
    );
  }

  /** Applies an `orun work import --dry-run` plan (idempotent on re-import;
   *  imports NO lifecycle — rungs derive from observations after apply). */
  import(orgId: string, plan: WorkImportRequest, opts: RequestOptions = {}): Promise<WorkImportResponse> {
    return this.transport.request<WorkImportResponse>(
      { method: "POST", path: `${workBase(orgId)}/import`, body: plan },
      opts,
    );
  }

  private taskAction(
    orgId: string,
    key: string,
    action: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<WorkMutationResponse> {
    return this.transport.request<WorkMutationResponse>(
      { method: "POST", path: `${workBase(orgId)}/tasks/${encodeURIComponent(key)}/${action}`, body },
      opts,
    );
  }
}
