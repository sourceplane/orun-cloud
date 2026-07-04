// Work client (orun-work v2 WP1) — the work lens over the edge.
//
// Reads return the fold's output (rungs WITH evidence, recomputed on every
// request); there is deliberately no setStatus method — lifecycle is a
// derived query (WP-3). Writes are coordination-log mutations; a rejected
// mutation surfaces as a typed OrunCloudError carrying the mutator's verdict.

import type {
  IngestWorkObservationRequest,
  IngestWorkObservationResponse,
  CreateWorkSpecRequest,
  CreateWorkSpecResponse,
  CreateWorkTaskRequest,
  CreateWorkTaskResponse,
  ListWorkEventsResponse,
  WorkAssignRequest,
  WorkCommentRequest,
  WorkContractRequest,
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
