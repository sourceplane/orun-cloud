import type {
  CreateWorkspaceLinkRequest,
  CreateWorkspaceLinkResponse,
  ResolveWorkspaceLinksResponse,
  WorkspaceLink,
  ListOrgCatalogEntitiesResponse,
  ListRepoFacetsResponse,
  GetRepoFacetResponse,
  GetStateStorageResponse,
  GetStateGcReportResponse,
  CollectStateGcRequest,
  CollectStateGcResponse,
  ListRunsResponse,
  GetRunResponse,
  ListJobsResponse,
  ReadLogResponse,
  StateCursor,
} from "@saas/contracts/state";
import { STATE_CONTRACT_VERSION } from "@saas/contracts/state";

import type { Transport, RequestOptions } from "./transport.js";

/** Console list response (project Settings → CLI page). */
export interface ListWorkspaceLinksResponse {
  links: WorkspaceLink[];
}

/** Org-wide allow-list response (console repo allow-list view), keyset-paged. */
export interface ListOrgWorkspaceLinksResponse {
  links: WorkspaceLink[];
  nextCursor: StateCursor | null;
}

/** Filters for the org-wide workspace-link (allow-list) listing. */
export interface OrgLinksQuery {
  cursor?: string;
  limit?: number;
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
 * Filters for the ORG-GLOBAL runs feed (the console "Activities" surface). The
 * merged run history across the org's projects; `project` narrows to a repo,
 * `branch` filters by source branch (git ref, refs/heads/ normalized away), and
 * `source` by initiator (cli|ci). All optional.
 */
export interface OrgRunsQuery {
  /** Provenance filter: a project public id (prj_…). */
  project?: string;
  environment?: string;
  status?: string;
  /** Source branch (e.g. 'main'); matches git_ref with refs/heads/ stripped. */
  branch?: string;
  /** Run initiator. */
  source?: "cli" | "ci";
  /** Keyset cursor from a prior page. */
  cursor?: string;
  /** Page size. */
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

  /**
   * GET /v1/organizations/:orgId/cli/links — the org-wide repo allow-list: every
   * active workspace link across the org's projects, keyset-paginated. Powers the
   * console's "Git Repos → Settings" allow-list view. Policy: org.cli.link.
   */
  listOrgLinks(
    orgId: string,
    query: OrgLinksQuery = {},
    opts: RequestOptions = {},
  ): Promise<ListOrgWorkspaceLinksResponse> {
    return this.transport.request<ListOrgWorkspaceLinksResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/cli/links`,
        query: { cursor: query.cursor, limit: query.limit },
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
   * GET /v1/organizations/:orgId/repo-facets — the repo self-descriptions for
   * the org (saas-workspace-overview WO5): one per project, projected from the
   * declared Repo entity. Drives the Git Repos list + the Workspace Overview
   * identity. Policy: catalog.read.
   */
  listRepoFacets(orgId: string, opts: RequestOptions = {}): Promise<ListRepoFacetsResponse> {
    return this.transport.request<ListRepoFacetsResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/repo-facets` },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/repo-facets/:projectId — one project's facet. */
  getRepoFacet(orgId: string, projectId: string, opts: RequestOptions = {}): Promise<GetRepoFacetResponse> {
    return this.transport.request<GetRepoFacetResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/repo-facets/${encodeURIComponent(projectId)}`,
      },
      opts,
    );
  }

  /**
   * Read a content-addressed object's body as text by digest (WO5): the
   * doc-overview markdown a `doc_ref.digest` points at. Raw bytes → text (not
   * the JSON envelope); the object plane is under `/state/`, so the contract
   * version header is required. Policy: state.object.read.
   */
  readObjectText(
    orgId: string,
    projectId: string,
    digest: string,
    opts: RequestOptions = {},
  ): Promise<string> {
    return this.transport.requestText(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(
          projectId,
        )}/state/objects/${encodeURIComponent(digest)}`,
      },
      { ...opts, headers: { "orun-contract-version": String(STATE_CONTRACT_VERSION), ...(opts.headers ?? {}) } },
    );
  }

  /**
   * GET /v1/organizations/:orgId/state/usage — the org's current state-plane
   * storage footprint (OV9): live object + log-chunk counts and bytes. A STOCK
   * gauge (distinct from the metering FLOW metrics). Policy: catalog.read.
   */
  getStateStorage(orgId: string, opts: RequestOptions = {}): Promise<GetStateStorageResponse> {
    return this.transport.request<GetStateStorageResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/state/usage`,
      },
      opts,
    );
  }

  /**
   * GET /v1/organizations/:orgId/projects/:projectId/state/gc/report — object GC
   * reachability report (OV9, report-only): reclaimable storage for the project,
   * computed from the live-pointer closure. Reads only; deletes nothing. Policy:
   * state.object.read.
   */
  getGcReport(orgId: string, projectId: string, opts: RequestOptions = {}): Promise<GetStateGcReportResponse> {
    return this.transport.request<GetStateGcReportResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/state/gc/report`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/projects/:projectId/state/gc/collect — reclaim
   * unreachable objects (OV9). Safe by default: omit `dryRun` (or pass true) to
   * preview; actual deletion also requires the env master switch and a complete
   * (non-capped) reachability walk. Policy: state.object.write.
   */
  collectGc(
    orgId: string,
    projectId: string,
    body: CollectStateGcRequest = {},
    opts: RequestOptions = {},
  ): Promise<CollectStateGcResponse> {
    return this.transport.request<CollectStateGcResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/state/gc/collect`,
        body,
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

  /**
   * GET /v1/organizations/:orgId/state/runs — the org-global runs feed (the
   * console "Activities" surface). The merged run history across every project
   * in the org, newest first, each row carrying its provenance (project,
   * environment, git ref). `project` narrows to a single repo; `environment`,
   * `status`, `branch`, and `source` are facets over the merged feed. Policy:
   * state.run.read at the organization scope.
   */
  listOrgRuns(
    orgId: string,
    query: OrgRunsQuery = {},
    opts: RequestOptions = {},
  ): Promise<ListRunsResponse> {
    return this.transport.request<ListRunsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/state/runs`,
        query: {
          project: query.project,
          environment: query.environment,
          status: query.status,
          branch: query.branch,
          source: query.source,
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
