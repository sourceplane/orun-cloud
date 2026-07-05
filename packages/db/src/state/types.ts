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

/**
 * Filters for the ORG-GLOBAL runs feed (the console "Activities" surface). Like
 * the org catalog projection, runs are merged across every project in the org;
 * `projectId` narrows to one repo, the rest are facets over the merged feed.
 * `branch` matches `git_ref` with the `refs/heads/` prefix normalized away, so
 * `main` matches both `main` and `refs/heads/main`.
 */
export interface ListOrgRunsQuery {
  projectId?: Uuid;
  environment?: string;
  status?: RunStatus;
  branch?: string;
  source?: RunSource;
}

/** Per-status job tallies for the run projection (jobCounts in the contract). */
export interface RunJobCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
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
  | "artifact-manifest"
  // Object model structural kinds (OV1).
  | "blob"
  | "tree";

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

// ── Refs (hosted RefStore, L2 mutable CAS pointers; OV1) ────

/** A mutable name → ObjectID pointer over the immutable object graph. */
export interface StateRef {
  id: string;
  orgId: string;
  projectId: string;
  /** Logical ref name, e.g. 'catalogs/current', 'executions/by-id/exec_00'. */
  name: string;
  /** Object id the ref points at ('sha256:<hex>'); exists in state.objects. */
  target: string;
  /** Last compare-and-swap writer: cli|runner|tui|saas|github. */
  writer: string | null;
  updatedAt: Date;
}

/**
 * Compare-and-swap update of a ref. expectedTarget "" requires the ref be
 * absent (create); a non-empty expectedTarget requires the current target to
 * match (advance). The outcome reports whether the swap won.
 */
export interface UpdateRefInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  name: string;
  expectedTarget: string;
  newTarget: string;
  writer?: string | null;
}

export type UpdateRefOutcome =
  | { kind: "updated"; ref: StateRef }
  /** CAS lost: the current target did not equal expectedTarget. */
  | { kind: "conflict"; current: StateRef | null }
  /** newTarget is not present in state.objects (the closure wasn't uploaded). */
  | { kind: "target_missing" };

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

// ── Org-global catalog projection (OV6 read-model) ──────────

/** A row in the merged org-wide catalog graph, with provenance. */
export interface OrgCatalogEntity {
  id: string;
  orgId: string;
  entityRef: string;
  kind: string;
  name: string;
  owner: string | null;
  lifecycle: string | null;
  relations: CatalogEntityRelation[];
  /** Git-authored portal fields (CP4); null/[] when the snapshot omits them. */
  description: string | null;
  system: string | null;
  language: string | null;
  tags: string[];
  /** Nullable {path,ref,sha,digest} pointer to the entity's docs.overview blob
   *  in CAS (saas-workspace-overview WO4); the body is read from R2 by digest. */
  docRef: Record<string, unknown> | null;
  sourceProjectId: string;
  sourceEnvironment: string | null;
  sourceCommit: string | null;
  headDigest: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertOrgCatalogEntityInput {
  id: string;
  orgId: Uuid;
  entityRef: string;
  kind: string;
  name: string;
  sourceProjectId: Uuid;
  headDigest: string;
  owner?: string | null;
  lifecycle?: string | null;
  relations?: CatalogEntityRelation[];
  description?: string | null;
  system?: string | null;
  language?: string | null;
  tags?: string[];
  docRef?: Record<string, unknown> | null;
  sourceEnvironment?: string | null;
  sourceCommit?: string | null;
}

/** A repo self-description row (state.repo_facet), one per (org, project),
 *  projected from the declared Repo entity (saas-workspace-overview WO4). */
export interface RepoFacet {
  orgId: string;
  sourceProjectId: string;
  displayName: string | null;
  description: string | null;
  owner: string | null;
  defaultBranch: string | null;
  links: Array<Record<string, unknown>>;
  tags: string[];
  docRef: Record<string, unknown> | null;
  entityRef: string | null;
  headDigest: string;
  sourceCommit: string | null;
  syncedAt: Date;
}

export interface UpsertRepoFacetInput {
  orgId: Uuid;
  sourceProjectId: Uuid;
  headDigest: string;
  displayName?: string | null;
  description?: string | null;
  owner?: string | null;
  defaultBranch?: string | null;
  links?: Array<Record<string, unknown>>;
  tags?: string[];
  docRef?: Record<string, unknown> | null;
  entityRef?: string | null;
  sourceCommit?: string | null;
}

/** One row in the org-wide catalog doc index (state.catalog_docs) — one
 *  attached doc of one entity's doc set (saas-catalog-docs CD3). Identity is
 *  (entityRef, docKey); digest is the CAS content address the body reads by. */
export interface CatalogDoc {
  id: string;
  orgId: string;
  sourceProjectId: string;
  sourceEnvironment: string | null;
  entityRef: string;
  entityKind: string;
  entityName: string;
  docKey: string;
  title: string;
  role: string;
  path: string;
  commitSha: string | null;
  digest: string;
  sizeBytes: number | null;
  position: number;
  headDigest: string;
  syncedAt: Date;
  createdAt: Date;
}

export interface UpsertCatalogDocInput {
  id: string;
  orgId: Uuid;
  sourceProjectId: Uuid;
  sourceEnvironment?: string | null;
  entityRef: string;
  entityKind: string;
  entityName: string;
  docKey: string;
  title: string;
  role: string;
  path: string;
  commitSha?: string | null;
  digest: string;
  sizeBytes?: number | null;
  position: number;
  headDigest: string;
}

/** Docs-hub browse filters (all optional). */
export interface ListCatalogDocsQuery {
  sourceProjectId?: Uuid;
  sourceEnvironment?: string | null;
  entityKind?: string;
  entityRef?: string;
  role?: string;
  q?: string;
}

/** One scope needing (re)projection: the current head the read model must catch
 *  up to. Returned by listPendingCatalogProjections (the cron-sweep drive set). */
export interface PendingCatalogProjection {
  orgId: string;
  projectId: string;
  environment: string | null;
  digest: string; // the current head digest the read model must reach
  commit: string | null;
}

/** Org-global browse filters (all optional; provenance + facets). */
export interface ListOrgCatalogEntitiesQuery {
  sourceProjectId?: Uuid;
  sourceEnvironment?: string | null;
  kind?: string;
  owner?: string;
  q?: string;
}

/** Current state-plane storage footprint for an org (OV9), a live STOCK count. */
export interface StateStorageUsage {
  objects: { count: number; bytes: number };
  logs: { count: number; bytes: number };
}

// ── Workspace links ─────────────────────────────────────────

export type WorkspaceLinkStatus = "active" | "unlinked";

/** Rename-stable SCM provider identity for a workspace link (OV2.1). */
export interface ProviderIdentity {
  /** SCM host family: 'github' | 'gitlab' | … */
  provider: string | null;
  /** Host's rename-stable repo id (federation matches on this, never name). */
  providerRepoId: string | null;
  providerOwnerId: string | null;
  /** Account login — display only, never matched on. */
  providerOwnerLogin: string | null;
}

/**
 * Per-link CI trust settings (OV3). The link is the trust binding; these
 * tighten which credential methods and (for OIDC) which refs/environments may
 * mint a workflow token. Permissive defaults (both methods, null = "any")
 * preserve link-as-trust semantics.
 */
export interface LinkCiSettings {
  oidcEnabled: boolean;
  apiKeyEnabled: boolean;
  /** Glob over the Actions ref claim; null = any ref. */
  allowedRefPattern: string | null;
  /** Allowed environment names; null = any environment. */
  allowedEnvironments: string[] | null;
}

export interface WorkspaceLink extends ProviderIdentity {
  id: string;
  orgId: string;
  projectId: string;
  remoteUrl: string;
  status: WorkspaceLinkStatus;
  ciSettings: LinkCiSettings;
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
  /** Optional rename-stable provider identity (set when the linker knows it). */
  provider?: ProviderIdentity;
}

/** Author per-link CI settings (console/CLI). Omitted fields are unchanged. */
export interface UpdateWorkspaceLinkCiSettingsInput {
  orgId: Uuid;
  id: Uuid;
  oidcEnabled?: boolean;
  apiKeyEnabled?: boolean;
  allowedRefPattern?: string | null;
  allowedEnvironments?: string[] | null;
}

// ── scm.* triggers (OV4 — GitHub App bridge inbound projection) ─

export type TriggerKind = "push" | "pull_request";

/** A normalized source-control trigger projected from an scm.* event. */
export interface StateTrigger {
  id: string;
  orgId: string;
  projectId: string | null;
  provider: string;
  providerRepoId: string;
  repoFullName: string | null;
  kind: TriggerKind;
  action: string | null;
  ref: string | null;
  commitSha: string;
  baseSha: string | null;
  prNumber: number | null;
  actorLogin: string | null;
  /** Source events.event_log id (provenance + idempotency key). */
  eventId: string;
  status: string;
  occurredAt: Date;
  createdAt: Date;
}

export interface RecordTriggerInput {
  id: string;
  orgId: Uuid;
  projectId?: Uuid | null;
  provider: string;
  providerRepoId: string;
  repoFullName?: string | null;
  kind: TriggerKind;
  action?: string | null;
  ref?: string | null;
  commitSha: string;
  baseSha?: string | null;
  prNumber?: number | null;
  actorLogin?: string | null;
  eventId: string;
  occurredAt: Date;
}

/** created=false when the event was already recorded (idempotent no-op). */
export interface RecordTriggerOutcome {
  trigger: StateTrigger;
  created: boolean;
}

/** The scm.* ingestion consumer's high-water mark. */
export interface ScmIngestCursor {
  lastOccurredAt: string | null;
  lastEventId: string | null;
}

export interface ListTriggersQuery {
  projectId?: Uuid | null;
  providerRepoId?: string;
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
  /**
   * Org-global runs feed across every project (the console "Activities"
   * surface), newest first. `query.projectId` narrows to a single repo; the
   * remaining filters are facets over the merged feed.
   */
  listOrgRuns(
    orgId: Uuid,
    params: PageQueryParams,
    query?: ListOrgRunsQuery,
  ): Promise<StateResult<PagedResult<Run>>>;

  // Run jobs
  createRunJob(input: CreateRunJobInput): Promise<StateResult<RunJob>>;
  getRunJob(orgId: Uuid, projectId: Uuid, runId: Uuid, jobId: string): Promise<StateResult<RunJob>>;
  listRunJobs(orgId: Uuid, projectId: Uuid, runId: Uuid): Promise<StateResult<RunJob[]>>;
  /** Frontier: queued jobs whose deps are all terminal-success. */
  listRunnableJobs(orgId: Uuid, projectId: Uuid, runId: Uuid): Promise<StateResult<RunJob[]>>;
  /** Per-status job tallies for the run projection. */
  getRunJobCounts(orgId: Uuid, projectId: Uuid, runId: Uuid): Promise<StateResult<RunJobCounts>>;

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
  /**
   * Object GC (OV9, report-only): every stored object's digest + byte size for a
   * project, bounded by `limit`. Diffed against the reachable closure to compute
   * reclaimable storage.
   */
  listObjectDigestsWithSize(
    orgId: Uuid,
    projectId: Uuid,
    limit: number,
  ): Promise<StateResult<{ digest: string; sizeBytes: number; createdAt: string }[]>>;
  /** Object GC reclamation (OV9): drop one unreachable object's index row. */
  deleteObject(orgId: Uuid, projectId: Uuid, digest: string): Promise<StateResult<boolean>>;
  /**
   * Object GC roots: every live pointer's target for a project — current ref
   * targets, retained catalog-head digests, and run plan digests. The reachable
   * set is the closure of these (conservative: retained history keeps its
   * objects reachable, so the report never over-claims reclaimable storage).
   */
  listStorageGcRoots(orgId: Uuid, projectId: Uuid): Promise<StateResult<string[]>>;

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

  // Org-global catalog projection (OV6 read-model)
  /** Idempotently project one entity into the org graph (per source scope). */
  upsertOrgCatalogEntity(input: UpsertOrgCatalogEntityInput): Promise<StateResult<OrgCatalogEntity>>;
  /** Org-global browse: merged graph for an org, provenance/facet filtered. */
  listOrgCatalogEntities(
    orgId: Uuid,
    params: PageQueryParams,
    query?: ListOrgCatalogEntitiesQuery,
  ): Promise<StateResult<PagedResult<OrgCatalogEntity>>>;
  /**
   * Remove a (project, environment) scope's projected rows — the projector's
   * "replace the scope" primitive: delete-then-reproject makes a head-advance
   * idempotent and drops entities no longer in the new snapshot. Returns the
   * number of rows removed.
   */
  deleteOrgCatalogEntitiesForScope(
    orgId: Uuid,
    sourceProjectId: Uuid,
    sourceEnvironment: string | null,
  ): Promise<StateResult<number>>;

  // Repo facet (saas-workspace-overview WO4) — per-(org,project) self-description.
  /** Idempotently project the repo's self-description (one row per project). */
  upsertRepoFacet(input: UpsertRepoFacetInput): Promise<StateResult<RepoFacet>>;
  /** Remove a project's repo_facet row — the "replace the scope" primitive so a
   *  head advance that drops the `repo:` block clears the stale facet. */
  deleteRepoFacetForScope(orgId: Uuid, sourceProjectId: Uuid): Promise<StateResult<number>>;
  /** Read one project's repo facet, or null when none is projected. */
  getRepoFacet(orgId: Uuid, sourceProjectId: Uuid): Promise<StateResult<RepoFacet | null>>;
  /** List every projected repo facet for an org (the Git Repos list). */
  listRepoFacets(orgId: Uuid): Promise<StateResult<RepoFacet[]>>;
  /** Resolve a doc blob digest to the project that references it in this org's
   *  catalog read model (repo_facet or org_catalog_entities doc_ref) — both the
   *  authorization ("is this a catalog doc in my org?") and the object's scope
   *  for the read. Returns null when the digest is not a catalog doc here. */
  findCatalogDocProject(orgId: Uuid, digest: string): Promise<StateResult<Uuid | null>>;

  // Catalog doc index (saas-catalog-docs CD3) — one row per attached doc.
  /** Idempotently project one attached doc of an entity's doc set. */
  upsertCatalogDoc(input: UpsertCatalogDocInput): Promise<StateResult<CatalogDoc>>;
  /** Remove a scope's doc rows — the "replace the scope" primitive, run in the
   *  same projection pass as deleteOrgCatalogEntitiesForScope. */
  deleteCatalogDocsForScope(
    orgId: Uuid,
    sourceProjectId: Uuid,
    sourceEnvironment: string | null,
  ): Promise<StateResult<number>>;
  /** Browse the org-wide doc index (Docs hub / entity Docs tab), keyset-paged. */
  listCatalogDocs(
    orgId: Uuid,
    params: PageQueryParams,
    query?: ListCatalogDocsQuery,
  ): Promise<StateResult<PagedResult<CatalogDoc>>>;

  // Catalog-projection outbox (projection reliability) — records which head each
  // scope's read model has caught up to, so a stuck projection is self-healing.
  /** Record that a scope's read model was successfully projected at `digest`
   *  (clears the failure counter). */
  recordCatalogProjectionSuccess(
    orgId: Uuid,
    projectId: Uuid,
    environment: string | null,
    digest: string,
  ): Promise<StateResult<void>>;
  /** Record a failed projection attempt for a scope (increments attempts, keeps
   *  the last good projected_digest so the sweep keeps retrying). */
  recordCatalogProjectionFailure(
    orgId: Uuid,
    projectId: Uuid,
    environment: string | null,
    error: string,
  ): Promise<StateResult<void>>;
  /** The cron-sweep drive set: scopes whose current catalog head has not been
   *  projected (projected_digest lags the head), capped by attempts and bounded. */
  listPendingCatalogProjections(
    limit: number,
    maxAttempts: number,
  ): Promise<StateResult<PendingCatalogProjection[]>>;

  /**
   * Current state-plane storage footprint for an org (OV9): live object + log
   * counts and byte sums from the indexes. A STOCK gauge (distinct from the
   * metering FLOW metrics) — the basis for storage quotas.
   */
  getOrgStateStorage(orgId: Uuid): Promise<StateResult<StateStorageUsage>>;

  // Refs (hosted RefStore — L2 mutable CAS pointers; OV1)
  /** Read one ref by name (current target). */
  getRef(orgId: Uuid, projectId: Uuid, name: string): Promise<StateResult<StateRef>>;
  /** Compare-and-swap a ref (create-if-absent or conditional advance). */
  updateRef(input: UpdateRefInput): Promise<StateResult<UpdateRefOutcome>>;
  /** List ref names under a prefix, name-ordered. */
  listRefs(orgId: Uuid, projectId: Uuid, prefix: string): Promise<StateResult<StateRef[]>>;
  /** Delete a ref by name (idempotent; no-op when absent). */
  deleteRef(orgId: Uuid, projectId: Uuid, name: string): Promise<StateResult<void>>;

  // scm.* triggers (OV4 — GitHub App bridge inbound projection)
  /** Idempotently record a normalized scm.* trigger (no-op on a known event). */
  recordTrigger(input: RecordTriggerInput): Promise<StateResult<RecordTriggerOutcome>>;
  /** Read the scm.* ingestion consumer's high-water mark. */
  readScmIngestCursor(): Promise<StateResult<ScmIngestCursor>>;
  /** Advance the scm.* ingestion cursor (upsert the single high-water row). */
  advanceScmIngestCursor(lastOccurredAt: string, lastEventId: string): Promise<StateResult<void>>;
  /** Read the run-result write-back driver's high-water mark (OV5/IG9). */
  readRunWritebackCursor(): Promise<StateResult<ScmIngestCursor>>;
  /** Advance the run-result write-back cursor (upsert the single high-water row). */
  advanceRunWritebackCursor(lastOccurredAt: string, lastEventId: string): Promise<StateResult<void>>;
  /** Activity feed: triggers for an org (optionally a project / repo), newest first. */
  listTriggers(
    orgId: Uuid,
    params: PageQueryParams,
    query?: ListTriggersQuery,
  ): Promise<StateResult<PagedResult<StateTrigger>>>;

  // Workspace links
  createWorkspaceLink(input: CreateWorkspaceLinkInput): Promise<StateResult<WorkspaceLink>>;
  getWorkspaceLink(orgId: Uuid, id: Uuid): Promise<StateResult<WorkspaceLink>>;
  listWorkspaceLinks(
    orgId: Uuid,
    projectId: Uuid,
    params: PageQueryParams,
  ): Promise<StateResult<PagedResult<WorkspaceLink>>>;
  /**
   * Allow-list probe: whether an ACTIVE workspace link (the repo allow-list
   * entry) exists for the (org, project). Gates OIDC-CI state-object pushes —
   * removing/unlinking the repo immediately revokes CI's ability to push.
   */
  hasActiveWorkspaceLink(orgId: Uuid, projectId: Uuid): Promise<StateResult<boolean>>;
  /**
   * Org-wide allow-list: the active workspace links across every project in the
   * org (the console's repo allow-list view), newest first, keyset-paginated.
   */
  listOrgWorkspaceLinks(
    orgId: Uuid,
    params: PageQueryParams,
  ): Promise<StateResult<PagedResult<WorkspaceLink>>>;
  /** Resolve scan: active links for a normalized remote across the actor's orgs. */
  listActiveWorkspaceLinksForRemote(remoteUrl: string): Promise<StateResult<WorkspaceLink[]>>;
  /** Federation scan: active links for a rename-stable (provider, repo id). */
  listActiveWorkspaceLinksForProviderRepo(
    provider: string,
    providerRepoId: string,
  ): Promise<StateResult<WorkspaceLink[]>>;
  /** Author per-link CI trust settings (OV3). */
  updateWorkspaceLinkCiSettings(
    input: UpdateWorkspaceLinkCiSettingsInput,
  ): Promise<StateResult<WorkspaceLink>>;
  /** Soft-unlink: flips status to 'unlinked'; the row remains for audit. */
  unlinkWorkspaceLink(orgId: Uuid, id: Uuid): Promise<StateResult<WorkspaceLink>>;
}
