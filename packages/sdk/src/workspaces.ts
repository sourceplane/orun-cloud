import type {
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  GetOrganizationResponse,
  ListOrganizationsResponse,
} from "@saas/contracts/membership";

import type { Transport, RequestOptions } from "./transport.js";

/**
 * Workspaces resource client — the public Account/Workspace vocabulary
 * (saas-workspaces WS3 / `specs/core/vocabulary.md`).
 *
 * A **Workspace** is any organization in an account; `workspaceId` is the same
 * opaque `org_*` id as `orgId`. This client maps 1:1 to the api-edge
 * `/v1/workspaces` surface, which is a thin alias of `/v1/organizations`
 * (WS2) — same handlers, identical results, plus a projected `workspaceId`.
 *
 * `client.organizations` remains available as the legacy spelling.
 */
export class WorkspacesClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/workspaces — workspaces the actor is a member of. */
  list(opts: RequestOptions = {}): Promise<ListOrganizationsResponse> {
    return this.transport.request<ListOrganizationsResponse>(
      { method: "GET", path: "/v1/workspaces" },
      opts,
    );
  }

  /** GET /v1/workspaces/:workspaceId */
  get(workspaceId: string, opts: RequestOptions = {}): Promise<GetOrganizationResponse> {
    return this.transport.request<GetOrganizationResponse>(
      { method: "GET", path: `/v1/workspaces/${encodeURIComponent(workspaceId)}` },
      opts,
    );
  }

  /**
   * POST /v1/workspaces
   *
   * Pass `idempotencyKey` in `opts` to make the request safely retryable.
   */
  create(
    body: CreateOrganizationRequest,
    opts: RequestOptions = {},
  ): Promise<CreateOrganizationResponse> {
    return this.transport.request<CreateOrganizationResponse>(
      { method: "POST", path: "/v1/workspaces", body },
      opts,
    );
  }
}
