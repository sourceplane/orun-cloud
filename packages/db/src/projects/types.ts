export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";

export type ProjectsRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type ProjectsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProjectsRepositoryError };

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  slugLower: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface Environment {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  slug: string;
  slugLower: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  /**
   * Last time this environment was pushed to (a run/plan referencing it),
   * bumped on every activity touch. The OV9 stale-archival sweep keys off it.
   */
  lastActiveAt: Date;
}

export interface CreateProjectInput {
  id: string;
  orgId: Uuid;
  name: string;
  slug: string;
  slugLower: string;
  createdAt: Date;
}

export interface CreateEnvironmentInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  name: string;
  slug: string;
  slugLower: string;
  createdAt: Date;
}

/**
 * Create-or-touch an environment by (org, project, slug). The first call
 * inserts (using `id`); subsequent calls bump `last_active_at` to `at` and
 * revive an archived row. The OV9 liveness signal — driven by the state-worker
 * run-create seam, not a user action.
 */
export interface RegisterEnvironmentActivityInput {
  /** Candidate id used only when the row is inserted (absent today). */
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  name: string;
  slug: string;
  slugLower: string;
  /** The activity timestamp (last_active_at, and updated_at on touch). */
  at: Date;
}

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

export interface ProjectsRepository {
  createProject(input: CreateProjectInput): Promise<ProjectsResult<Project>>;
  getProjectById(orgId: Uuid, projectId: Uuid): Promise<ProjectsResult<Project>>;
  getProjectBySlug(orgId: Uuid, slugLower: string): Promise<ProjectsResult<Project>>;
  listProjectsPaged(orgId: Uuid, params: PageQueryParams): Promise<ProjectsResult<PagedResult<Project>>>;
  archiveProject(orgId: Uuid, projectId: Uuid, archivedAt: Date): Promise<ProjectsResult<Project>>;
  /**
   * Count of active (non-archived) projects for an organization. Used by
   * domain callers (e.g. projects-worker) to compare against entitlement
   * limits without loading a full page of projects.
   */
  countActiveProjects(orgId: Uuid): Promise<ProjectsResult<number>>;

  createEnvironment(input: CreateEnvironmentInput): Promise<ProjectsResult<Environment>>;
  /**
   * Create-or-touch an environment by (org, project, slug_lower), returning the
   * row and whether it was freshly inserted. Bumps `last_active_at` (and revives
   * an archived row) on an existing match. The OV9 activity touch.
   */
  registerEnvironmentActivity(
    input: RegisterEnvironmentActivityInput,
  ): Promise<ProjectsResult<{ environment: Environment; created: boolean }>>;
  /**
   * Archive up to `limit` active environments whose `last_active_at` predates
   * `cutoff`, stamping `archived_at = archivedAt`. Returns the archived rows
   * (oldest-first) so the caller can emit a per-environment archival event. The
   * OV9 stale-archival sweep; reversible — a later activity touch revives a row.
   */
  archiveStaleEnvironments(
    cutoff: Date,
    archivedAt: Date,
    limit: number,
  ): Promise<ProjectsResult<Environment[]>>;
  /**
   * Count of active (non-archived) environments under a specific parent
   * project. Used by domain callers (e.g. projects-worker) to compare
   * against `limit.environments` entitlement quotas before creating a
   * new environment row. The count is intentionally scoped to
   * `org_id + project_id` because environment APIs are project-scoped.
   */
  countActiveEnvironments(orgId: Uuid, projectId: Uuid): Promise<ProjectsResult<number>>;
  getEnvironmentById(orgId: Uuid, projectId: Uuid, environmentId: string): Promise<ProjectsResult<Environment>>;
  getEnvironmentBySlug(orgId: Uuid, projectId: Uuid, slugLower: string): Promise<ProjectsResult<Environment>>;
  /**
   * Paginate a project's environments, newest-first. Active-only by default;
   * pass `{ includeArchived: true }` to also return archived rows (so the
   * console can show what the OV9 sweep archived).
   */
  listEnvironmentsPaged(
    orgId: Uuid,
    projectId: Uuid,
    params: PageQueryParams,
    opts?: { includeArchived?: boolean },
  ): Promise<ProjectsResult<PagedResult<Environment>>>;
  archiveEnvironment(orgId: Uuid, projectId: Uuid, environmentId: string, archivedAt: Date): Promise<ProjectsResult<Environment>>;
}
