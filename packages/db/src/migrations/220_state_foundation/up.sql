-- 220_state_foundation: State persistence foundation (OP0).
--
-- Context: state
-- Epic: saas-orun-platform (OP0) — the dormant contract-and-schema slice for
--       Orun Cloud's run-coordination + object/catalog plane (the state-worker
--       bounded context). No live behavior rides on this migration; it lands
--       the schema so OP2+ (run coordination, object/log plane, catalog,
--       workspace links) are schema-complete from day one. The state-worker
--       skeleton stays health-only until OP2 wires the routes.
--
-- Design rules (see specs/epics/saas-orun-platform/design.md §4 and
-- state-api-contract.md):
--   * Two planes mirror Orun's own architecture: an immutable content-
--     addressed object plane (objects + catalog heads) and a mutable run-
--     coordination plane (runs + run_jobs + log_chunks).
--   * Tenant isolation: every table carries org_id + project_id NOT NULL and
--     is denormalized so every query scopes by org_id (house rule). Composite
--     FKs reference the owning table's (org_id, id)-class unique key so a child
--     row can never point across a tenant boundary (mirrors
--     projects.environments → projects.projects and the IG0 tables).
--   * Runs are keyed by a client-supplied ULID (idempotent create); jobs are
--     keyed by (run, plan-DAG job id); objects are keyed by content digest.
--   * Catalog heads are the only mutable pointers in the object plane; history
--     is retained (advancing a head inserts; the latest per scope wins).
--   * Object/log/secret bytes never live in Postgres — blob bytes are in R2;
--     these tables hold only the index/coordination rows.
--   * Keyset pagination indexes (org_id, created_at DESC, id DESC).
--   * Idempotent: IF NOT EXISTS throughout for Supabase autocommit safety.

CREATE SCHEMA IF NOT EXISTS state;

COMMENT ON SCHEMA state IS 'State bounded context — owns run coordination, the content-addressed object/catalog index, logs, and Orun workspace links.';

-- ── Runs (mutable coordination plane, design §4.2) ──────────
-- One run per client-minted ULID. The ULID is the public id and the
-- idempotent-create key (a replayed create returns the existing row). Run
-- status is derived by the lease sweep from its jobs (never asserted directly).

CREATE TABLE IF NOT EXISTS state.runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  environment   TEXT,                            -- environment slug; null until a plan references one
  run_ulid      TEXT NOT NULL,                   -- client-supplied ULID (public runId; sortable)
  plan_digest   TEXT NOT NULL,                   -- 'sha256:<hex>' → state.objects
  source        TEXT NOT NULL DEFAULT 'cli'
                  CHECK (source IN ('cli', 'ci')),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
  git_commit    TEXT,
  git_ref       TEXT,
  git_dirty     BOOLEAN NOT NULL DEFAULT false,
  labels        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- free-form, indexed for list filters
  created_by    TEXT,                            -- actor public id
  created_by_kind TEXT,                          -- actor kind (user|service_principal|workflow|system)
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE state.runs IS 'Runs within a project. Every query must scope by org_id. run_ulid is the public, idempotent-create key.';

-- Idempotent create + public-id lookup: one run per (org, project, ULID)
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_runs_ulid
  ON state.runs (org_id, project_id, run_ulid);

-- Composite unique target for the run_jobs / log_chunks FK (tenant-safe)
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_runs_org_project_id
  ON state.runs (org_id, project_id, id);

-- List runs by project, newest first with id tie-breaker
CREATE INDEX IF NOT EXISTS idx_state_runs_project
  ON state.runs (org_id, project_id, created_at DESC, id DESC);

-- Filtered list (environment / status) within a project
CREATE INDEX IF NOT EXISTS idx_state_runs_status
  ON state.runs (org_id, project_id, status, created_at DESC, id DESC);

-- ── Run jobs (the plan DAG, design §4.2) ────────────────────
-- One row per (run, plan-DAG job id). Claim is a single conditional UPDATE on
-- this table; heartbeat extends lease_expires_at; the sweep re-queues lapsed
-- claims (attempt+1, bounded) or times them out.

CREATE TABLE IF NOT EXISTS state.run_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  project_id      UUID NOT NULL,
  run_id          UUID NOT NULL,
  job_id          TEXT NOT NULL,                 -- plan DAG job id (stable across attempts)
  component       TEXT,                          -- catalog component this job acts on
  deps            JSONB NOT NULL DEFAULT '[]'::jsonb,  -- job ids this job depends on
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'claimed', 'running', 'succeeded',
                                      'failed', 'timed_out', 'canceled')),
  runner_id       TEXT,                          -- opaque runner holding the current lease
  lease_expires_at TIMESTAMPTZ,
  attempt         INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  error_text      TEXT,                          -- safe failure summary; never raw step output
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (org_id, project_id, run_id)
    REFERENCES state.runs (org_id, project_id, id)
);

COMMENT ON TABLE state.run_jobs IS 'Jobs in a run plan DAG. Claim/heartbeat/update mutate this table; status is queued→claimed→running→terminal.';

-- One row per (run, plan job id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_run_jobs_job
  ON state.run_jobs (run_id, job_id);

-- List/frontier scan for a run, ordered by job id for stable output
CREATE INDEX IF NOT EXISTS idx_state_run_jobs_run
  ON state.run_jobs (org_id, project_id, run_id, job_id);

-- Lease sweep scan: claimed/running jobs with a lease that may have lapsed
CREATE INDEX IF NOT EXISTS idx_state_run_jobs_lease
  ON state.run_jobs (lease_expires_at)
  WHERE status IN ('claimed', 'running');

-- ── Objects (immutable CAS plane index, design §4.1) ────────
-- Index rows for content-addressed blobs stored in R2 at
-- state/{orgId}/{projectId}/objects/{digest}. Same-digest re-upload is a no-op
-- (idempotent PUT) — the unique key enforces it.

CREATE TABLE IF NOT EXISTS state.objects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  digest        TEXT NOT NULL,                   -- 'sha256:<hex>' content address
  kind          TEXT NOT NULL
                  CHECK (kind IN ('plan', 'catalog-snapshot', 'composition-lock', 'artifact-manifest')),
  size_bytes    BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  created_by    TEXT,                            -- actor public id
  created_by_kind TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE state.objects IS 'Content-addressed object index (blob bytes live in R2). One row per (org, project, digest); re-upload is idempotent.';

-- Content address is unique within a tenant scope (idempotent PUT keystone).
-- Doubles as the composite-FK target for catalog_heads (head digest must exist).
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_objects_digest
  ON state.objects (org_id, project_id, digest);

-- Index listing by kind, newest first
CREATE INDEX IF NOT EXISTS idx_state_objects_kind
  ON state.objects (org_id, project_id, kind, created_at DESC, id DESC);

-- ── Log chunks (append-only, chunked; design §4.3) ──────────
-- Index rows for log chunks stored in R2 at
-- state/{org}/{project}/runs/{runId}/logs/{jobId}/{seq}. Reads assemble bytes
-- from R2; this table is the (run, job, seq) ledger + live-tail cursor source.

CREATE TABLE IF NOT EXISTS state.log_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  run_id        UUID NOT NULL,
  job_id        TEXT NOT NULL,                   -- plan DAG job id (matches run_jobs.job_id)
  seq           INTEGER NOT NULL CHECK (seq >= 0),  -- monotonic per (run, job)
  byte_length   INTEGER NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (org_id, project_id, run_id)
    REFERENCES state.runs (org_id, project_id, id)
);

COMMENT ON TABLE state.log_chunks IS 'Append-only log chunk index keyed by (run, job, seq). Chunk bytes live in R2; fromSeq polling is the live-tail mechanism.';

-- One row per (run, job, seq) — append idempotency + ordered assembly
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_log_chunks_seq
  ON state.log_chunks (run_id, job_id, seq);

-- Live-tail read: chunks for a job from a cursor seq onward
CREATE INDEX IF NOT EXISTS idx_state_log_chunks_job
  ON state.log_chunks (org_id, project_id, run_id, job_id, seq);

-- ── Catalog heads (mutable pointers; design §4.1) ───────────
-- The only mutable pointers in the object plane: (project, environment?) →
-- catalog-snapshot digest. History is retained — advancing a head inserts a
-- new row; the latest per scope is the current head. The pointed-at digest
-- must exist in state.objects (composite FK, tenant-safe).

CREATE TABLE IF NOT EXISTS state.catalog_heads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  environment   TEXT,                            -- null = project-wide head
  digest        TEXT NOT NULL,                   -- 'sha256:<hex>' → state.objects (kind catalog-snapshot)
  commit        TEXT,                            -- source git commit the snapshot was resolved at
  advanced_by   TEXT,                            -- actor public id
  advanced_by_kind TEXT,
  advanced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (org_id, project_id, digest)
    REFERENCES state.objects (org_id, project_id, digest)
);

COMMENT ON TABLE state.catalog_heads IS 'Catalog head pointers (project, environment?) → catalog-snapshot digest. History retained; latest per scope is current.';

-- Head history + current-head lookup, newest first per scope.
-- environment NULL is normalized to '' so the index treats the project-wide
-- head as a first-class scope row (NULLs would otherwise not collate together).
CREATE INDEX IF NOT EXISTS idx_state_catalog_heads_scope
  ON state.catalog_heads (org_id, project_id, COALESCE(environment, ''), advanced_at DESC, id DESC);

-- ── Catalog entities (read-model; design §5) ────────────────
-- Projected from a catalog snapshot at head-advance time so the console can
-- list/search/filter without parsing blobs per request. The platform NEVER
-- edits catalog content — these rows are derived, idempotently rebuildable
-- from the snapshot blob. Live-plane columns (scorecards/health) wait for OP7+.

CREATE TABLE IF NOT EXISTS state.catalog_entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  head_digest   TEXT NOT NULL,                   -- the snapshot digest this row was projected from
  entity_ref    TEXT NOT NULL,                   -- stable entity ref, e.g. 'component:default/api'
  kind          TEXT NOT NULL,                   -- Component | API | Resource | System | Domain | Group
  name          TEXT NOT NULL,
  owner         TEXT,
  lifecycle     TEXT,
  relations     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{type, targetRef}]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE state.catalog_entities IS 'Read-model projection of catalog entities at a head digest. Derived, never authored; idempotently rebuildable from the snapshot blob.';

-- One row per (project, head digest, entity ref) — idempotent re-projection
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_catalog_entities_ref
  ON state.catalog_entities (org_id, project_id, head_digest, entity_ref);

-- Entity browser: list/search by kind within the current head
CREATE INDEX IF NOT EXISTS idx_state_catalog_entities_kind
  ON state.catalog_entities (org_id, project_id, head_digest, kind, name);

-- Faceted filter by owner
CREATE INDEX IF NOT EXISTS idx_state_catalog_entities_owner
  ON state.catalog_entities (org_id, project_id, head_digest, owner)
  WHERE owner IS NOT NULL;

-- ── Workspace links (design §2; state-api-contract §5) ──────
-- Orun's own link object: (org, project, normalized git remote URL). Distinct
-- from integrations.repo_links — a workspace link works for any git remote
-- with no GitHub App installed. Created on first `orun cloud link`.

CREATE TABLE IF NOT EXISTS state.workspace_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  remote_url    TEXT NOT NULL,                   -- normalized git remote (host/owner/repo; scheme + auth stripped)
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'unlinked')),
  created_by    TEXT,                            -- actor public id
  created_by_kind TEXT,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  -- org_id / project_id are opaque cross-context references (no cross-schema
  -- FK, per the house rule — the projects context owns those rows). Composite
  -- FKs are used only within this schema (run_jobs/log_chunks → runs,
  -- catalog_heads → objects).
);

COMMENT ON TABLE state.workspace_links IS 'Orun workspace links: (org, project) ↔ normalized git remote. Any git remote; no GitHub App required. Distinct from integrations.repo_links.';

-- One ACTIVE link per (org, normalized remote); historical unlinked rows remain
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_workspace_link_remote
  ON state.workspace_links (org_id, remote_url)
  WHERE status = 'active';

-- Resolve scan: which orgs/projects link a given remote (active only)
CREATE INDEX IF NOT EXISTS idx_state_workspace_links_remote
  ON state.workspace_links (remote_url)
  WHERE status = 'active';

-- List links by project, newest first
CREATE INDEX IF NOT EXISTS idx_state_workspace_links_project
  ON state.workspace_links (org_id, project_id, created_at DESC, id DESC);
