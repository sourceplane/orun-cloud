import type {
  CreateWorkspaceLinkRequest,
  CreateWorkspaceLinkResponse,
  ResolveWorkspaceLinksResponse,
  WorkspaceLink,
  ListOrgCatalogEntitiesResponse,
  ListRunsResponse,
  GetRunResponse,
  ListJobsResponse,
  ReadLogResponse,
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

/** Filters for the org-global catalog browser (OV6/OV7). All optional. */
export interface OrgCatalogEntitiesQuery {
  /** Provenance filter: a project public id (prj_…). */
  project?: string;
  /** Provenance filter: an environment slug. */
  environment?: string;
  /** Facet: entity kind (Component | API | System | …). */
  kind?: string;
  /** Facet: owner. */
  owner?: string;
  /** Free-text match over name/ref. */
  q?: string;
  /** Keyset cursor from a prior page. */
  cursor?: string;
  /** Page size. */
  limit?: number;
}

/** Filters for the project runs list (OV7). All optional. */
export interface RunsQuery {
  environment?: string;
  status?: string;
  cursor?: string;
  limit?: number;
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

  /**
   * GET /v1/organizations/:orgId/catalog/entities — the org-global catalog
   * browser (OV6). The merged component graph across the org's projects, each
   * row carrying provenance; project/environment narrow to a repo/env sublist,
   * kind/owner are facets, q matches name or ref. Policy: catalog.read.
   */
  listOrgCatalogEntities(
    orgId: string,
    query: OrgCatalogEntitiesQuery = {},
    opts: RequestOptions = {},
  ): Promise<ListOrgCatalogEntitiesResponse> {
    return this.transport.request<ListOrgCatalogEntitiesResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/catalog/entities`,
        query: {
          project: query.project,
          environment: query.environment,
          kind: query.kind,
          owner: query.owner,
          q: query.q,
          cursor: query.cursor,
          limit: query.limit,
        },
      },
      opts,
    );
  }

  /**
   * GET /v1/organizations/:orgId/projects/:projectId/state/runs — the project's
   * runs list (OV7), newest first, filterable by environment/status. Policy:
   * state.run.read.
   */
  listRuns(
    orgId: string,
    projectId: string,
    query: RunsQuery = {},
    opts: RequestOptions = {},
  ): Promise<ListRunsResponse> {
    return this.transport.request<ListRunsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/state/runs`,
        query: {
          environment: query.environment,
          status: query.status,
          cursor: query.cursor,
          limit: query.limit,
        },
      },
      opts,
    );
  }

  /** GET …/state/runs/:runId — one run's projection (OV7 run detail). */
  getRun(
    orgId: string,
    projectId: string,
    runId: string,
    opts: RequestOptions = {},
  ): Promise<GetRunResponse> {
    return this.transport.request<GetRunResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/state/runs/${encodeURIComponent(runId)}`,
      },
      opts,
    );
  }

  /** GET …/state/runs/:runId/jobs — the run's plan-DAG jobs (OV7 run detail). */
  listRunJobs(
    orgId: string,
    projectId: string,
    runId: string,
    opts: RequestOptions = {},
  ): Promise<ListJobsResponse> {
    return this.transport.request<ListJobsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/state/runs/${encodeURIComponent(runId)}/jobs`,
      },
      opts,
    );
  }

  /**
   * GET …/state/runs/:runId/logs/:jobId?fromSeq= — a job's assembled logs plus a
   * live-tail cursor (OV7 run detail). `fromSeq` resumes from a prior nextSeq so
   * the console tails by re-fetching the tail rather than the whole log.
   */
  readRunJobLogs(
    orgId: string,
    projectId: string,
    runId: string,
    jobId: string,
    fromSeq = 0,
    opts: RequestOptions = {},
  ): Promise<ReadLogResponse> {
    return this.transport.request<ReadLogResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/state/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(jobId)}`,
        query: { fromSeq },
      },
      opts,
    );
  }
}
