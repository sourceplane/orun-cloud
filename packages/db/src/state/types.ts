import type { Uuid } from "../ids/index.js";

export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";

// ── Result type ─────────────────────────────────────────────

export type StateRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type StateResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: StateRepositoryError };

// ── Cursor pagination (matches existing convention) ─────────

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

// ── Shared provenance ───────────────────────────────────────

export type ActorKind = "user" | "service_principal" | "workflow" | "system";

/** Actor that performed a mutation (projected from ActorContext). */
export interface ActorStamp {
  id: string | null;
  kind: ActorKind | null;
}

// ── Runs ────────────────────────────────────────────────────

export type RunSource = "cli" | "ci";

export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface Run {
  id: string;
  orgId: string;
  projectId: string;
  environment: string | null;
  /** Client-minted ULID (public runId). */
  runUlid: string;
  planDigest: string;
  source: RunSource;
  status: RunStatus;
  gitCommit: string | null;
  gitRef: string | null;
  gitDirty: boolean;
  labels: Record<string, string>;
  createdBy: ActorStamp;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRunInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  runUlid: string;
  planDigest: string;
  source: RunSource;
  environment?: string | null;
  gitCommit?: string | null;
  gitRef?: string | null;
  gitDirty?: boolean;
  labels?: Record<string, string>;
  createdBy?: ActorStamp;
}

/** Result of an idempotent create: created=false on a replayed ULID. */
export interface CreateRunOutcome {
  run: Run;
  created: boolean;
}

export interface ListRunsQuery {
  environment?: string;
  status?: RunStatus;
}

// ── Run jobs ────────────────────────────────────────────────

export type RunJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "canceled";

export interface RunJob {
  id: string;
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  component: string | null;
  deps: string[];
  status: RunJobStatus;
  runnerId: string | null;
  leaseExpiresAt: Date | null;
  attempt: number;
  errorText: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRunJobInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  runId: Uuid;
  jobId: string;
  component?: string | null;
  deps?: string[];
}

// ── Objects (CAS index) ─────────────────────────────────────

export type StateObjectKind =
  | "plan"
  | "catalog-snapshot"
  | "composition-lock"
  | "artifact-manifest";

export interface StateObject {
  id: string;
  orgId: string;
  projectId: string;
  digest: string;
  kind: StateObjectKind;
  sizeBytes: number;
  createdBy: ActorStamp;
  createdAt: Date;
}

export interface UpsertObjectInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  digest: string;
  kind: StateObjectKind;
  sizeBytes: number;
  createdBy?: ActorStamp;
}

/** Result of an idempotent PUT: created=false when the digest already existed. */
export interface UpsertObjectOutcome {
  object: StateObject;
  created: boolean;
}

// ── Log chunks ──────────────────────────────────────────────

export interface LogChunk {
  id: string;
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  seq: number;
  byteLength: number;
  createdAt: Date;
}

export interface AppendLogChunkInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  runId: Uuid;
  jobId: string;
  seq: number;
  byteLength: number;
}

// ── Catalog heads ───────────────────────────────────────────

export interface CatalogHead {
  id: string;
  orgId: string;
  projectId: string;
  environment: string | null;
  digest: string;
  commit: string | null;
  advancedBy: ActorStamp;
  advancedAt: Date;
}

export interface AdvanceCatalogHeadInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  environment?: string | null;
  digest: string;
  commit?: string | null;
  advancedBy?: ActorStamp;
}

// ── Catalog entities (read-model) ───────────────────────────

export interface CatalogEntityRelation {
  type: string;
  targetRef: string;
}

export interface CatalogEntity {
  id: string;
  orgId: string;
  projectId: string;
  headDigest: string;
  entityRef: string;
  kind: string;
  name: string;
  owner: string | null;
  lifecycle: string | null;
  relations: CatalogEntityRelation[];
  createdAt: Date;
}

export interface UpsertCatalogEntityInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  headDigest: string;
  entityRef: string;
  kind: string;
  name: string;
  owner?: string | null;
  lifecycle?: string | null;
  relations?: CatalogEntityRelation[];
}

export interface ListCatalogEntitiesQuery {
  kind?: string;
  owner?: string;
  q?: string;
}

// ── Workspace links ─────────────────────────────────────────

export type WorkspaceLinkStatus = "active" | "unlinked";

export interface WorkspaceLink {
  id: string;
  orgId: string;
  projectId: string;
  remoteUrl: string;
  status: WorkspaceLinkStatus;
  createdBy: ActorStamp;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkspaceLinkInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  remoteUrl: string;
  createdBy?: ActorStamp;
}

// ── Repository interface ────────────────────────────────────

export interface StateRepository {
  // Runs
  createRun(input: CreateRunInput): Promise<StateResult<CreateRunOutcome>>;
  getRun(orgId: Uuid, projectId: Uuid, id: Uuid): Promise<StateResult<Run>>;
  /** Public-id lookup for idempotent create + client GET by ULID. */
  getRunByUlid(orgId: Uuid, projectId: Uuid, runUlid: string): Promise<StateResult<Run>>;
  listRuns(
    orgId: Uuid,
    projectId: Uuid,
    params: PageQueryParams,
    query?: ListRunsQuery,
  ): Promise<StateResult<PagedResult<Run>>>;

  // Run jobs
  createRunJob(input: CreateRunJobInput): Promise<StateResult<RunJob>>;
  getRunJob(orgId: Uuid, projectId: Uuid, runId: Uuid, jobId: string): Promise<StateResult<RunJob>>;
  listRunJobs(orgId: Uuid, projectId: Uuid, runId: Uuid): Promise<StateResult<RunJob[]>>;

  // Objects (CAS index)
  upsertObject(input: UpsertObjectInput): Promise<StateResult<UpsertObjectOutcome>>;
  getObject(orgId: Uuid, projectId: Uuid, digest: string): Promise<StateResult<StateObject>>;
  /** Digest negotiation: subset of `digests` the scope is missing. */
  listMissingObjects(orgId: Uuid, projectId: Uuid, digests: string[]): Promise<StateResult<string[]>>;
  listObjects(
    orgId: Uuid,
    projectId: Uuid,
    params: PageQueryParams,
    query?: { kind?: StateObjectKind },
  ): Promise<StateResult<PagedResult<StateObject>>>;

  // Log chunks
  appendLogChunk(input: AppendLogChunkInput): Promise<StateResult<LogChunk>>;
  listLogChunks(
    orgId: Uuid,
    projectId: Uuid,
    runId: Uuid,
    jobId: string,
    fromSeq: number,
  ): Promise<StateResult<LogChunk[]>>;

  // Catalog heads
  advanceCatalogHead(input: AdvanceCatalogHeadInput): Promise<StateResult<CatalogHead>>;
  getCatalogHead(
    orgId: Uuid,
    projectId: Uuid,
    environment: string | null,
  ): Promise<StateResult<CatalogHead>>;
  listCatalogHeadHistory(
    orgId: Uuid,
    projectId: Uuid,
    params: PageQueryParams,
  ): Promise<StateResult<PagedResult<CatalogHead>>>;

  // Catalog entities (read-model)
  upsertCatalogEntity(input: UpsertCatalogEntityInput): Promise<StateResult<CatalogEntity>>;
  listCatalogEntities(
    orgId: Uuid,
    projectId: Uuid,
    headDigest: string,
    params: PageQueryParams,
    query?: ListCatalogEntitiesQuery,
  ): Promise<StateResult<PagedResult<CatalogEntity>>>;

  // Workspace links
  createWorkspaceLink(input: CreateWorkspaceLinkInput): Promise<StateResult<WorkspaceLink>>;
  getWorkspaceLink(orgId: Uuid, id: Uuid): Promise<StateResult<WorkspaceLink>>;
  listWorkspaceLinks(
    orgId: Uuid,
    projectId: Uuid,
    params: PageQueryParams,
  ): Promise<StateResult<PagedResult<WorkspaceLink>>>;
  /** Resolve scan: active links for a normalized remote across the actor's orgs. */
  listActiveWorkspaceLinksForRemote(remoteUrl: string): Promise<StateResult<WorkspaceLink[]>>;
  /** Soft-unlink: flips status to 'unlinked'; the row remains for audit. */
  unlinkWorkspaceLink(orgId: Uuid, id: Uuid): Promise<StateResult<WorkspaceLink>>;
}
