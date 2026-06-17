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

// ── Claim / heartbeat / update / sweep ──────────────────────

/** Why a claim attempt did not win (mirrors contract JobClaim.reason). */
export type ClaimRefusedReason = "already_claimed" | "deps_not_ready" | "terminal";

/**
 * Outcome of the atomic conditional claim UPDATE. Exactly one concurrent caller
 * for a given job can observe `claimed: true` (the row transition is a single
 * SQL statement guarded on `status = 'queued'` and not-claimed). The loser is
 * told why with the job's current state so the handler can map it to the wire
 * reason without a second read race.
 */
export type ClaimRunJobOutcome =
  | { claimed: true; job: RunJob }
  | { claimed: false; reason: ClaimRefusedReason };

export interface ClaimRunJobInput {
  orgId: Uuid;
  projectId: Uuid;
  runId: Uuid;
  jobId: string;
  runnerId: string;
  /** Lease window in seconds (default 60). */
  leaseSeconds: number;
}

export interface HeartbeatRunJobInput {
  orgId: Uuid;
  projectId: Uuid;
  runId: Uuid;
  jobId: string;
  runnerId: string;
  leaseSeconds: number;
}

/** A heartbeat either extends the lease or finds it lost/reassigned. */
export type HeartbeatOutcome =
  | { ok: true; job: RunJob }
  | { ok: false; reason: "lease_lost" };

export interface UpdateRunJobInput {
  orgId: Uuid;
  projectId: Uuid;
  runId: Uuid;
  jobId: string;
  runnerId: string;
  status: "succeeded" | "failed";
  errorText?: string | null;
}

/**
 * Outcome of an idempotent terminal transition. `replayed: true` means the
 * (run, job, runner, status) tuple was already applied — a no-op that returns
 * the same result. `lease_lost` means the runner no longer holds the lease.
 */
export type UpdateRunJobOutcome =
  | { ok: true; job: RunJob; replayed: boolean }
  | { ok: false; reason: "lease_lost" };

/** One lapsed-lease job acted on by the sweep. */
export interface SweptJob {
  job: RunJob;
  /** `requeued` → put back to queued (attempt+1); `timed_out` → terminal. */
  outcome: "requeued" | "timed_out";
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
  /** Frontier: queued jobs whose deps are all terminal-success. */
  listRunnableJobs(orgId: Uuid, projectId: Uuid, runId: Uuid): Promise<StateResult<RunJob[]>>;
  /**
   * Atomic conditional claim — a single guarded UPDATE. At most one concurrent
   * caller wins; the rest observe `claimed: false`. Deps readiness is enforced
   * in the same statement so a job whose deps are not all succeeded is refused
   * with `deps_not_ready` without ever transitioning.
   */
  claimRunJob(input: ClaimRunJobInput): Promise<StateResult<ClaimRunJobOutcome>>;
  /** Extend the lease iff the runner still holds it; else `lease_lost`. */
  heartbeatRunJob(input: HeartbeatRunJobInput): Promise<StateResult<HeartbeatOutcome>>;
  /**
   * Idempotent terminal transition. Replaying the same (run, job, runner,
   * status) is a no-op returning the prior row; a different runner (lease lost)
   * is refused with `lease_lost`.
   */
  updateRunJob(input: UpdateRunJobInput): Promise<StateResult<UpdateRunJobOutcome>>;
  /**
   * Sweep lapsed leases for a scope-less scan (cron). Re-queues jobs whose
   * lease expired (attempt+1) up to `maxAttempts`, else marks them `timed_out`.
   * Returns the rows it acted on so the caller can emit lifecycle events.
   */
  sweepLapsedLeases(now: Date, maxAttempts: number, limit: number): Promise<StateResult<SweptJob[]>>;
  /**
   * Cancel a run: terminal-cancel its non-terminal jobs and set the run to
   * `canceled`. Idempotent on an already-terminal run. Returns the run row.
   */
  cancelRun(orgId: Uuid, projectId: Uuid, runId: Uuid): Promise<StateResult<Run>>;
  /**
   * Recompute and persist a run's derived terminal status from its jobs.
   * Returns the (possibly unchanged) run and whether it transitioned to a new
   * terminal state on this call (so the caller emits completed/failed once).
   */
  reconcileRunStatus(
    orgId: Uuid,
    projectId: Uuid,
    runId: Uuid,
  ): Promise<StateResult<{ run: Run; transitioned: RunStatus | null }>>;
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

  // Refs (hosted RefStore — L2 mutable CAS pointers; OV1)
  /** Read one ref by name (current target). */
  getRef(orgId: Uuid, projectId: Uuid, name: string): Promise<StateResult<StateRef>>;
  /** Compare-and-swap a ref (create-if-absent or conditional advance). */
  updateRef(input: UpdateRefInput): Promise<StateResult<UpdateRefOutcome>>;
  /** List ref names under a prefix, name-ordered. */
  listRefs(orgId: Uuid, projectId: Uuid, prefix: string): Promise<StateResult<StateRef[]>>;
  /** Delete a ref by name (idempotent; no-op when absent). */
  deleteRef(orgId: Uuid, projectId: Uuid, name: string): Promise<StateResult<void>>;

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
