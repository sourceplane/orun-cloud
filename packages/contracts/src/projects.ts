export interface PublicProject {
  id: string;
  orgId: string;
  /**
   * Public Workspace alias of `orgId` (same opaque `org_*` id). Present on the
   * `/v1/workspaces/*` surface; omitted on the legacy `/v1/organizations/*`
   * surface. See `specs/core/vocabulary.md` (saas-workspaces WS2).
   */
  workspaceId?: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateProjectRequest {
  name: string;
  slug?: string;
}

export interface CreateProjectResponse {
  project: PublicProject;
}

export interface GetProjectResponse {
  project: PublicProject;
}

export interface ListProjectsResponse {
  projects: PublicProject[];
}

export interface ArchiveProjectResponse {
  project: PublicProject;
}

export interface PublicEnvironment {
  id: string;
  orgId: string;
  /**
   * Public Workspace alias of `orgId` (same opaque `org_*` id). Present on the
   * `/v1/workspaces/*` surface only. See `specs/core/vocabulary.md`.
   */
  workspaceId?: string;
  projectId: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /**
   * Last time the environment was pushed to (a run/plan/catalog-push
   * referencing it). The OV9 stale-archival sweep archives an active
   * environment whose last_active_at predates the retention window.
   */
  lastActiveAt: string;
}

export interface CreateEnvironmentRequest {
  name: string;
  slug?: string;
}

export interface CreateEnvironmentResponse {
  environment: PublicEnvironment;
}

export interface GetEnvironmentResponse {
  environment: PublicEnvironment;
}

export interface ListEnvironmentsResponse {
  environments: PublicEnvironment[];
}

export interface ArchiveEnvironmentResponse {
  environment: PublicEnvironment;
}
