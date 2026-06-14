import type {
  CreateWorkspaceLinkRequest,
  CreateWorkspaceLinkResponse,
  ResolveWorkspaceLinksResponse,
  WorkspaceLink,
} from "@saas/contracts/state";

import type { Transport, RequestOptions } from "./transport.js";

/** Console list response (project Settings → CLI page). */
export interface ListWorkspaceLinksResponse {
  links: WorkspaceLink[];
}

/** DELETE .../cli/links/:linkId response. */
export interface UnlinkWorkspaceLinkResponse {
  deleted: boolean;
}

/**
 * State resource client — workspace links + tenancy resolution (OP4).
 *
 * Maps to `apps/state-worker` via the api-edge `state-facade`. The CLI uses
 * `createLink` / `resolve`; the console uses `listLinks` / `unlink`.
 */
export class StateClient {
  constructor(private readonly transport: Transport) {}

  /**
   * POST /v1/organizations/:orgId/cli/links — create a workspace link,
   * creating the project on demand when absent (policy org.cli.link).
   */
  createLink(
    orgId: string,
    body: CreateWorkspaceLinkRequest,
    opts: RequestOptions = {},
  ): Promise<CreateWorkspaceLinkResponse> {
    return this.transport.request<CreateWorkspaceLinkResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/cli/links`,
        body,
      },
      opts,
    );
  }

  /**
   * GET /v1/cli/links/resolve?remoteUrl= — the candidate orgs/projects the
   * authenticated actor may link/use for a remote (powers the CLI picker).
   */
  resolve(remoteUrl: string, opts: RequestOptions = {}): Promise<ResolveWorkspaceLinksResponse> {
    return this.transport.request<ResolveWorkspaceLinksResponse>(
      {
        method: "GET",
        path: `/v1/cli/links/resolve`,
        query: { remoteUrl },
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/projects/:projectId/cli/links — console list. */
  listLinks(
    orgId: string,
    projectId: string,
    opts: RequestOptions = {},
  ): Promise<ListWorkspaceLinksResponse> {
    return this.transport.request<ListWorkspaceLinksResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/cli/links`,
      },
      opts,
    );
  }

  /** DELETE .../cli/links/:linkId — soft unlink. */
  unlink(
    orgId: string,
    projectId: string,
    linkId: string,
    opts: RequestOptions = {},
  ): Promise<UnlinkWorkspaceLinkResponse> {
    return this.transport.request<UnlinkWorkspaceLinkResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/cli/links/${encodeURIComponent(linkId)}`,
      },
      opts,
    );
  }
}
