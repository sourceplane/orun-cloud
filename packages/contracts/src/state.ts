// State contracts — Orun Cloud's run-coordination + object/catalog plane.
// Owner: state-worker (apps/state-worker).
//
// This is the platform-side projection of the wire contract that both repos
// implement (normative: specs/epics/saas-orun-platform/state-api-contract.md;
// model: design.md). Every state route is path-scoped under
// `/v1/organizations/{orgId}/projects/{projectId}/state/...`; the OSS
// single-tenant backend serves the same paths with a fixed `_local/_local`
// scope so one client codepath serves both.
//
// Safe projections only: no secret values, no raw object bytes, no log
// content beyond the assembled chunk a reader asked for. Object/log bytes live
// in R2; these shapes are what crosses the public API boundary and what
// `state.*` / `catalog.*` events carry on the event log.
//
// Spec: specs/components/18-state.md, specs/epics/saas-orun-platform/.

// ── Versioning ──────────────────────────────────────────────

/**
 * Contract major sent by the client on every request as
 * `Orun-Contract-Version: <n>`. Servers reject unknown majors with
 * `409 contract_version_unsupported` + the supported range, so version skew
 * fails loud and actionable at the CLI.
 */
export const STATE_CONTRACT_VERSION = 1 as const;

/** Request header carrying the client's contract major. */
export const STATE_CONTRACT_VERSION_HEADER = "Orun-Contract-Version" as const;

// ── Error codes ─────────────────────────────────────────────
// New state-plane error codes layered on the platform envelope
// (`{ error: { code, message, details?, requestId } }`). Listed here so every
// consumer (worker, api-edge facade, SDK, CLI) names them identically.

export const STATE_ERROR_CODES = {
  /** A second runner tried to claim a job that is already claimed/leased. */
  ALREADY_CLAIMED: "already_claimed",
  /** A heartbeat/update arrived from a runner whose lease lapsed or moved. */
  LEASE_LOST: "lease_lost",
  /** A job cannot be claimed because its dependencies are not terminal-success. */
  DEPS_NOT_READY: "deps_not_ready",
  /** A mutation targeted a run that has already reached a terminal status. */
  RUN_TERMINAL: "run_terminal",
  /** A referenced object digest does not exist in the object plane. */
  OBJECT_MISSING: "object_missing",
  /** A ref compare-and-swap lost: the current target did not match expected. */
  REF_CONFLICT: "ref_conflict",
  /** The request's `Orun-Contract-Version` major is unsupported. */
  CONTRACT_VERSION_UNSUPPORTED: "contract_version_unsupported",
} as const;

export type StateErrorCode =
  (typeof STATE_ERROR_CODES)[keyof typeof STATE_ERROR_CODES];

// ── Shared scope + provenance ───────────────────────────────

/**
 * Actor that performed a state mutation, projected from the platform's
 * ActorContext (never the raw token). `kind` reuses the tenancy actor model
 * — `workflow` is the OIDC-federated CI actor already present in tenancy.ts.
 */
export interface ActorRef {
  /** Opaque public actor id (`usr_…`, `sp_…`, or a workflow subject). */
  id: string;
  kind: "user" | "service_principal" | "workflow" | "system";
  /** Best-effort display label (login/email/ci-ref), never sensitive. */
  displayName?: string | null;
}

/** Where a run was initiated from. */
export type RunSource = "cli" | "ci";

/** Git provenance captured at run-create time. */
export interface GitProvenance {
  commit: string;
  ref: string;
  dirty: boolean;
}

// ── Runs (mutable coordination plane, design §4.2) ──────────

/**
 * Run lifecycle status. `pending` before the first claim; `running` once a job
 * is claimed; the terminal set is sticky and derived by the lease sweep.
 */
export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

/** Per-status job tallies surfaced on the run projection (cheap counters). */
export interface RunJobCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
}

/** Safe projection of a run (state-api-contract §2.1). */
export interface Run {
  /** Client-minted ULID; sortable, idempotent create key. */
  runId: string;
  orgId: string;
  projectId: string;
  /** Environment slug; null until a plan references one. */
  environment: string | null;
  status: RunStatus;
  /** `sha256:<hex>` of the plan object in the CAS plane. */
  planDigest: string;
  source: RunSource;
  git: GitProvenance;
  createdBy: ActorRef;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  jobCounts: RunJobCounts;
}

/**
 * Job lifecycle status within a run (design §4.2). `timed_out` is reached by
 * the lease sweep when a claimed job's lease lapses past bounded retries.
 */
export type RunJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "canceled";

/** Safe projection of a single job in a run's plan DAG. */
export interface RunJob {
  runId: string;
  /** Job id from the plan DAG (stable across attempts). */
  jobId: string;
  orgId: string;
  projectId: string;
  /** Catalog component this job acts on, when known. */
  component: string | null;
  /** Job ids this job depends on (must be terminal-success to claim). */
  deps: string[];
  status: RunJobStatus;
  /** Opaque runner id holding the current lease, when claimed. */
  runnerId: string | null;
  /** ISO-8601 lease expiry; the sweep re-queues past this. */
  leaseExpiresAt: string | null;
  /** 1-based attempt counter, incremented on re-queue. */
  attempt: number;
  /** Safe failure summary; never raw step output. */
  errorText: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Outcome of a claim attempt. Exactly one runner wins the conditional UPDATE;
 * the loser is told why (state-api-contract §2.2).
 */
export interface JobClaim {
  claimed: boolean;
  /** Present when claimed: ISO-8601 lease expiry. */
  leaseExpiresAt?: string;
  /** Present when claimed: the attempt this claim belongs to. */
  attempt?: number;
  /**
   * Present when claimed: the lease window in seconds the server granted. The
   * client uses this (never a hardcoded value) to schedule heartbeats and to
   * know when its lease lapses.
   */
  leaseSeconds?: number;
  /**
   * Present when claimed: how often the client should heartbeat, in seconds
   * (always < leaseSeconds). Returned so the client never hardcodes the
   * interval (state-api-contract §2.2).
   */
  heartbeatIntervalSeconds?: number;
  /** Present when not claimed: why the claim was refused. */
  reason?: "already_claimed" | "deps_not_ready" | "terminal";
}

// ── Logs (append-only, chunked; design §4.3) ────────────────

/**
 * Safe projection of one appended log chunk's index row. Content bytes live in
 * R2; reads return assembled content, not per-chunk rows.
 */
export interface LogChunk {
  runId: string;
  jobId: string;
  /** Monotonic per (run, job) sequence number. */
  seq: number;
  byteLength: number;
  createdAt: string;
}

// ── Object plane (CAS; design §4.1) ─────────────────────────

/**
 * Content-addressed object kinds the platform stores. The four semantic kinds
 * (plan, catalog-snapshot, …) plus the object model's two STRUCTURAL kinds
 * (blob, tree) — the hosted ObjectStore (OV1) stores the content-addressed
 * objects the CLI's RemoteStore uploads, each named by the hash of its framed
 * serialization (same id local and remote).
 */
export type StateObjectKind =
  | "plan"
  | "catalog-snapshot"
  | "composition-lock"
  | "artifact-manifest"
  | "blob"
  | "tree";

/**
 * Safe projection of a CAS index row. The blob bytes are in R2
 * (`state/{orgId}/{projectId}/objects/{digest}`); this is the metadata only.
 */
export interface StateObjectRef {
  orgId: string;
  projectId: string;
  /** `sha256:<hex>`; the content address and primary key within the scope. */
  digest: string;
  kind: StateObjectKind;
  sizeBytes: number;
  createdBy: ActorRef;
  createdAt: string;
}

// ── Catalog heads (the only mutable pointers in the CAS plane) ─

/**
 * Safe projection of a catalog head: a mutable pointer at a `catalog-snapshot`
 * object, scoped to (project, environment?). History is retained; advancing is
 * an audited mutation emitting `catalog.head.advanced`.
 */
export interface CatalogHead {
  orgId: string;
  projectId: string;
  /** Environment slug, or null for the project-wide head. */
  environment: string | null;
  /** `sha256:<hex>` of the pointed-at catalog snapshot. */
  digest: string;
  /** Source git commit the snapshot was resolved at, when known. */
  commit: string | null;
  advancedBy: ActorRef;
  advancedAt: string;
}

/**
 * Read-model row projected from a catalog snapshot at head-advance time
 * (design §5). Lets the console list/search/filter without parsing blobs per
 * request. Live-plane columns (scorecards/health) are reserved for OP7+.
 */
export interface CatalogEntity {
  orgId: string;
  projectId: string;
  /** Head digest this entity row was projected from. */
  headDigest: string;
  /** Stable entity ref within the catalog (e.g. `component:default/api`). */
  entityRef: string;
  /** Entity kind: Component | API | Resource | System | Domain | Group. */
  kind: string;
  name: string;
  owner: string | null;
  lifecycle: string | null;
  /** Relations to other entities (typed edges from the snapshot). */
  relations: Array<{ type: string; targetRef: string }>;
}

/**
 * One entity in the ORG-GLOBAL catalog projection (OV6 — design-v2 §6). The
 * default catalog view is a single org-wide component graph merged across every
 * project; each row carries its provenance (source project, environment, commit)
 * so "repo" and "env" are filters over the merged graph, not storage partitions.
 * Derived from the snapshot at head-advance, never authored.
 */
export interface OrgCatalogEntity {
  orgId: string;
  /** Stable entity ref (e.g. `component:default/api`); merged-graph identity is
   *  (sourceProjectId, sourceEnvironment, entityRef) to stay collision-free. */
  entityRef: string;
  kind: string;
  name: string;
  owner: string | null;
  lifecycle: string | null;
  relations: Array<{ type: string; targetRef: string }>;
  /** Provenance — the project this entity was projected from. */
  sourceProjectId: string;
  /** Provenance — the environment scope, or null for the project-wide head. */
  sourceEnvironment: string | null;
  /** Provenance — the git commit the snapshot was resolved at, when known. */
  sourceCommit: string | null;
  /** The catalog snapshot digest this row was projected from. */
  headDigest: string;
}

// ── Workspace links (design §2; state-api-contract §5) ──────

/**
 * Safe projection of an Orun workspace link: an org/project bound to a
 * normalized git remote URL. Distinct from `integrations.repo_links` — a
 * workspace link works for any git remote with no GitHub App installed.
 */
export interface WorkspaceLink {
  /** Public id, `wsl_<32hex>`. */
  id: string;
  orgId: string;
  orgSlug: string;
  projectId: string;
  projectSlug: string;
  /** Normalized git remote URL (host/owner/repo, scheme + auth stripped). */
  remoteUrl: string;
  /** SCM host family: 'github' | 'gitlab' | … (null when App-less / unknown). */
  provider: string | null;
  /** Rename-stable repo id; federation matches on this, never owner/name. */
  providerRepoId: string | null;
  providerOwnerId: string | null;
  /** Account login — display only. */
  providerOwnerLogin: string | null;
  /** Per-link CI trust settings (OV3). */
  ciSettings: LinkCiSettings;
  createdBy: ActorRef;
  createdAt: string;
  lastSeenAt: string | null;
}

/** Per-link CI trust settings (OV3). null = "any" (the link is the trust binding). */
export interface LinkCiSettings {
  oidcEnabled: boolean;
  apiKeyEnabled: boolean;
  allowedRefPattern: string | null;
  allowedEnvironments: string[] | null;
}

// ── Cursor pagination (matches the platform list convention) ─

export interface StateCursor {
  createdAt: string;
  id: string;
}

// ── Run coordination requests/responses (state-api-contract §2) ─

/** POST …/state/runs — idempotent by client `runId` (replay returns 200). */
export interface CreateRunRequest {
  runId: string;
  planDigest: string;
  environment?: string;
  source: RunSource;
  git: GitProvenance;
  labels?: Record<string, string>;
}

export interface CreateRunResponse {
  run: Run;
}

/** GET …/state/runs/{runId} */
export interface GetRunResponse {
  run: Run;
}

/** GET …/state/runs?environment=&status=&cursor= */
export interface ListRunsResponse {
  runs: Run[];
  nextCursor: StateCursor | null;
}

/** POST …/runs/{runId}/jobs/{jobId}/claim */
export interface ClaimJobRequest {
  runnerId: string;
}

export interface ClaimJobResponse {
  claim: JobClaim;
}

/** POST …/runs/{runId}/jobs/{jobId}/heartbeat */
export interface HeartbeatJobRequest {
  runnerId: string;
}

export interface HeartbeatJobResponse {
  /** Extended lease; the client never hardcodes the interval. */
  leaseExpiresAt: string;
  /** The lease window in seconds the server granted on this heartbeat. */
  leaseSeconds?: number;
  /** How often the client should heartbeat, in seconds (< leaseSeconds). */
  heartbeatIntervalSeconds?: number;
}

/** POST …/runs/{runId}/jobs/{jobId}/update — idempotent; terminal sticky. */
export interface UpdateJobRequest {
  runnerId: string;
  status: "succeeded" | "failed";
  errorText?: string;
}

export interface UpdateJobResponse {}

/** GET …/state/runs/{runId}/jobs */
export interface ListJobsResponse {
  jobs: RunJob[];
}

/** GET …/state/runs/{runId}/runnable — the queued frontier (deps succeeded). */
export interface RunnableJobsResponse {
  jobs: RunJob[];
}

/** POST …/state/runs/{runId}/cancel */
export interface CancelRunResponse {
  run: Run;
}

// ── Log requests/responses (state-api-contract §2.3) ────────

/** POST …/logs/{jobId} — appends a chunk (≤ 1 MiB) under the job's lease. */
export interface AppendLogRequest {
  runnerId: string;
  content: string;
}

export interface AppendLogResponse {
  seq: number;
}

/** GET …/logs/{jobId}?fromSeq= — assembled content + live-tail cursor. */
export interface ReadLogResponse {
  content: string;
  nextSeq: number;
  complete: boolean;
}

// ── Object plane requests/responses (state-api-contract §3) ──

/** POST …/state/objects/missing — digest negotiation. */
export interface ObjectsMissingRequest {
  digests: string[];
}

export interface ObjectsMissingResponse {
  missing: string[];
}

/** PUT …/state/objects/{digest} response (201 created | 200 already exists). */
export interface PutObjectResponse {
  object: StateObjectRef;
  /** False when the digest already existed (idempotent no-op). */
  created: boolean;
}

/** GET …/state/objects?kind=&cursor= — index listing (metadata only). */
export interface ListObjectsResponse {
  objects: StateObjectRef[];
  nextCursor: StateCursor | null;
}

// ── Catalog requests/responses (state-api-contract §3.1) ────

/** PUT …/state/catalog/head — advance; digest must exist. */
export interface PutCatalogHeadRequest {
  digest: string;
  environment?: string | null;
  commit?: string;
}

export interface PutCatalogHeadResponse {
  head: CatalogHead;
  /** The head this advance replaced, or null on first advance. */
  previous: CatalogHead | null;
}

/** GET …/state/catalog/head?environment= */
export interface GetCatalogHeadResponse {
  head: CatalogHead | null;
}

/** GET …/state/catalog/heads/history?cursor= */
export interface ListCatalogHeadHistoryResponse {
  heads: CatalogHead[];
  nextCursor: StateCursor | null;
}

/** GET …/state/catalog/entities?kind=&owner=&q=&cursor= */
export interface ListCatalogEntitiesResponse {
  entities: CatalogEntity[];
  nextCursor: StateCursor | null;
}

/**
 * GET /v1/organizations/{orgId}/catalog/entities — the org-global catalog
 * browser (OV6). Optional provenance/facet filters: `project` and `environment`
 * narrow to a repo/env sublist; `kind` / `owner` are facets; `q` matches name or
 * ref. Omitting all returns the merged org-wide graph, newest first.
 */
export interface ListOrgCatalogEntitiesResponse {
  entities: OrgCatalogEntity[];
  nextCursor: StateCursor | null;
}

/**
 * GET /v1/organizations/{orgId}/state/usage — current state-plane storage
 * footprint for the org (OV9). A live STOCK count from the object/log indexes
 * (distinct from the metering FLOW metrics), the basis for storage quotas.
 */
export interface StateStorageUsage {
  /** Content-addressed objects stored in the org's object plane. */
  objects: { count: number; bytes: number };
  /** Append-only log chunks stored for the org's runs. */
  logs: { count: number; bytes: number };
}

export interface GetStateStorageResponse {
  usage: StateStorageUsage;
}

/**
 * GET …/state/gc/report — object GC reachability report for a project (OV9,
 * report-only). How much of the object store no live pointer reaches, i.e. what
 * a future GC could reclaim. Computed, never mutated; nothing is deleted.
 */
export interface StateGcReport {
  totalObjects: number;
  totalBytes: number;
  reachableObjects: number;
  unreachableObjects: number;
  /** Bytes held by unreachable objects — the reclaimable estimate. */
  reclaimableBytes: number;
  /** The reachability walk hit its bound: reclaimableBytes is an upper bound. */
  capped: boolean;
}

export interface GetStateGcReportResponse {
  report: StateGcReport;
}

// ── Refs (hosted RefStore — L2 mutable CAS pointers; OV1) ────

/**
 * Safe projection of a ref: a mutable name → ObjectID pointer over the
 * immutable object graph. Selecting a source/head (a branch, a PR, the current
 * catalog) is resolving one of these.
 */
export interface StateRef {
  orgId: string;
  projectId: string;
  /** Logical ref name, e.g. 'catalogs/current', 'executions/by-id/exec_00'. */
  name: string;
  /** Object id the ref points at ('sha256:<hex>'). */
  target: string;
  /** Last compare-and-swap writer: cli|runner|tui|saas|github. */
  writer: string | null;
  updatedAt: string;
}

/** GET …/state/refs/{name} */
export interface GetRefResponse {
  ref: StateRef;
}

/**
 * PUT …/state/refs/{name} — compare-and-swap. expectedTarget "" (or omitted)
 * requires the ref be absent (create); a non-empty value requires the current
 * target to match (advance). 409 ref_conflict on a CAS loss; 412 object_missing
 * when the new target was never uploaded.
 */
export interface UpdateRefRequest {
  expectedTarget?: string;
  /** New object id to point at ('sha256:<hex>'); must exist in the object plane. */
  target: string;
}

export interface UpdateRefResponse {
  ref: StateRef;
}

/** GET …/state/refs?prefix= — list ref names under a prefix, name-ordered. */
export interface ListRefsResponse {
  refs: StateRef[];
}

// ── Triggers (scm.* activity projection; OV4 inbound bridge) ─

/** A source-control trigger (push / PR) projected from the event_log. */
export interface StateTrigger {
  orgId: string;
  projectId: string | null;
  provider: string;
  /** Rename-stable repo id. */
  providerRepoId: string;
  repoFullName: string | null;
  kind: "push" | "pull_request";
  /** PR action (opened|updated|merged|closed); null for push. */
  action: string | null;
  ref: string | null;
  commitSha: string;
  /** PR base commit SHA (the Merkle diff bound); null for push. */
  baseSha: string | null;
  prNumber: number | null;
  actorLogin: string | null;
  /** 'recorded' | 'materialized' — object-graph ingestion lifecycle. */
  status: string;
  occurredAt: string;
}

/** GET …/state/triggers?repo=&cursor= — the inbound activity feed. */
export interface ListTriggersResponse {
  triggers: StateTrigger[];
  nextCursor: StateCursor | null;
}

// ── Workspace link requests/responses (state-api-contract §5) ─

/** POST /v1/organizations/{orgId}/cli/links — creates project if absent. */
export interface CreateWorkspaceLinkRequest {
  remoteUrl: string;
  projectSlug?: string;
  /** Optional rename-stable provider identity (the CLI/App sets it when known). */
  provider?: string;
  providerRepoId?: string;
  providerOwnerId?: string;
  providerOwnerLogin?: string;
}

export interface CreateWorkspaceLinkResponse {
  link: WorkspaceLink;
}

/**
 * GET /v1/cli/links/resolve?remoteUrl= — the orgs/projects this actor may
 * link/use for that remote (powers `orun cloud link`'s picker).
 *
 * `candidates` are the existing active links for the normalized remote that the
 * actor may use (each already binds an org + project). It is the set the CLI
 * caches as its `RepoLink`. `links` is an alias kept for the CLI client that
 * reads the field by that name — same contents, same order.
 */
export interface ResolveWorkspaceLinksResponse {
  candidates: WorkspaceLink[];
  links: WorkspaceLink[];
}

// ── Event taxonomy ──────────────────────────────────────────

/** Platform lifecycle events emitted by the state context (design §7). */
export const STATE_EVENT_TYPES = {
  RUN_CREATED: "state.run.created",
  RUN_COMPLETED: "state.run.completed",
  RUN_FAILED: "state.run.failed",
  JOB_FAILED: "state.job.failed",
  CATALOG_HEAD_ADVANCED: "catalog.head.advanced",
  CLI_LINKED: "org.cli.linked",
  CLI_UNLINKED: "org.cli.unlinked",
} as const;

export type StateEventType =
  (typeof STATE_EVENT_TYPES)[keyof typeof STATE_EVENT_TYPES];

// ── Governance constants ────────────────────────────────────

/** Policy actions evaluated by policy-worker (deny-by-default; §6). */
export const STATE_POLICY_ACTIONS = {
  RUN_READ: "state.run.read",
  RUN_WRITE: "state.run.write",
  OBJECT_READ: "state.object.read",
  OBJECT_WRITE: "state.object.write",
  CATALOG_READ: "catalog.read",
  CATALOG_PUBLISH: "catalog.publish",
  SECRET_READ: "secret.read",
  SECRET_WRITE: "secret.write",
  SECRET_VALUE_USE: "secret.value.use",
  CLI_LINK: "org.cli.link",
  CI_TRUST_WRITE: "org.ci.trust.write",
} as const;

/** Entitlement keys gating the surface (412 + upgrade UX on deny; design §7). */
export const STATE_ENTITLEMENTS = {
  REMOTE_STATE: "feature.remote_state",
  SECRET_MANAGER: "feature.secret_manager",
  RUNS_PER_MONTH: "limit.state.runs_per_month",
  RETENTION_DAYS: "limit.state.retention_days",
  SECRETS_COUNT: "limit.secrets.count",
  STORAGE_GB: "limit.state.storage_gb",
} as const;
