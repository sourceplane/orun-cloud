-- 200_work_foundation: Work-plane persistence foundation (orun-work W0).
--
-- Context: work
-- Epic: orun-work (W0) — the system-of-record for the work plane: Initiatives,
--       Epics, and Tasks as event-sourced entities whose hot state lives here
--       (this Postgres backend), never in the content-addressed object graph
--       (CR-1). Mirrors orun's `internal/work` package, which is the
--       conformance oracle (see specs/orun-work/data-model.md).
--
-- Design rules:
--   * Tenant isolation: every table carries org_id UUID NOT NULL and
--     project_id UUID NOT NULL. The spec's abstract `project` ("<org>/<project>")
--     maps onto this (org_id, project_id) pair — the SaaS tenancy model.
--   * Append-only event log: work_events is the truth; work_status is a
--     derived projection that dropping and replaying the log reproduces
--     byte-for-byte (invariant 2).
--   * The closed event-kind / status / link-type vocabularies are enforced by
--     CHECK constraints so an out-of-set value is a write-time error (the SQL
--     mirror of the model's closed sets); extending a set is a schema rev.
--   * Per-(org,project) total order: work_events.seq is unique within a
--     project; allocation is serialized through work_sequences (the Postgres
--     equivalent of the spec's per-project Durable Object — the real backend is
--     Supabase/Postgres, not Cloudflare D1).
--   * Keyset pagination indexes (org_id, project_id, created_at DESC, id DESC).
--   * Idempotent: IF NOT EXISTS throughout for Supabase autocommit safety.

CREATE SCHEMA IF NOT EXISTS work;

-- ── Items (entity envelopes) ───────────────────────────────
-- One table for all three kinds (Initiative/Epic/Task). Hot runtime state
-- (status, assignees, ordering) is NOT here — it lives in work_status. The
-- envelope is what seals (invariant 1).

CREATE TABLE IF NOT EXISTS work.items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('Initiative', 'Epic', 'Task')),
  key           TEXT NOT NULL,                 -- human key: PREFIX-seq (Task) or slug
  title         TEXT NOT NULL,
  doc           TEXT,
  parent        TEXT,
  cycle         TEXT,
  labels        JSONB NOT NULL DEFAULT '{}'::jsonb,
  contract      JSONB,
  created_by    JSONB NOT NULL,                -- {type,id} principal ref
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_work_items_project
  ON work.items (org_id, project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_work_items_parent
  ON work.items (org_id, project_id, parent)
  WHERE parent IS NOT NULL;

-- ── Events (the append-only log; the truth) ────────────────

CREATE TABLE IF NOT EXISTS work.events (
  event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  subject       TEXT NOT NULL,                 -- the work key the event applies to
  kind          TEXT NOT NULL CHECK (kind IN (
                  'item_created', 'item_edited', 'status_changed', 'assigned',
                  'unassigned', 'comment_added', 'link_added', 'link_removed',
                  'contract_edited', 'moved', 'cycle_changed', 'labeled',
                  'unlabeled', 'sealed', 'imported', 'canceled')),
  actor         JSONB NOT NULL,                -- {type:user|agent|automation, id, via?}
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  seq           BIGINT NOT NULL,               -- per-(org,project) total order

  -- An event MUST name an actor with a known type (invariant 4). The id is a
  -- JSON string; emptiness is rejected by the mutator before insert.
  CONSTRAINT work_events_actor_typed CHECK (actor ->> 'type' IN ('user', 'agent', 'automation')),
  UNIQUE (org_id, project_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_work_events_subject
  ON work.events (org_id, project_id, subject, seq);

CREATE INDEX IF NOT EXISTS idx_work_events_stream
  ON work.events (org_id, project_id, seq);

-- ── Links (typed relation edges) ───────────────────────────

CREATE TABLE IF NOT EXISTS work.links (
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  from_key      TEXT NOT NULL,
  from_kind     TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN (
                  'partOf', 'hasPart', 'affects', 'blockedBy', 'blocks',
                  'implementedBy', 'delivers', 'assignedTo')),
  to_key        TEXT NOT NULL,
  to_kind       TEXT NOT NULL,
  created_by    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, project_id, from_key, type, to_key)
);

CREATE INDEX IF NOT EXISTS idx_work_links_to
  ON work.links (org_id, project_id, to_key, type);

-- ── Status (the rebuildable projection) ────────────────────
-- Dropping every row and replaying work_events reproduces this byte-for-byte
-- (invariant 2). updated_seq is the seq of the event that last touched the row.

CREATE TABLE IF NOT EXISTS work.status (
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  key           TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN (
                  'backlog', 'todo', 'in_progress', 'in_review', 'done',
                  'released', 'canceled')),
  assignees     JSONB NOT NULL DEFAULT '[]'::jsonb,
  board_order   DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_seq   BIGINT NOT NULL DEFAULT 0,

  PRIMARY KEY (org_id, project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_work_status_board
  ON work.status (org_id, project_id, status, board_order);

-- ── Cursors (seal + sync bookkeeping) ──────────────────────

CREATE TABLE IF NOT EXISTS work.cursors (
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  consumer      TEXT NOT NULL,                 -- e.g. 'seal', 'sync:<client>'
  seq           BIGINT NOT NULL DEFAULT 0,

  PRIMARY KEY (org_id, project_id, consumer)
);

-- ── Sequences (the Durable-Object-equivalent allocator) ────
-- One row per project holds the next event seq and the next task human-key
-- sequence. Allocation serializes through UPDATE ... RETURNING under the row
-- lock, giving the same total order a per-project Durable Object would.

CREATE TABLE IF NOT EXISTS work.sequences (
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  prefix        TEXT NOT NULL CHECK (prefix ~ '^[A-Z]{2,5}$'),
  next_seq      BIGINT NOT NULL DEFAULT 1,     -- next event seq to assign
  next_task_seq BIGINT NOT NULL DEFAULT 1,     -- next PREFIX-<n> to allocate

  PRIMARY KEY (org_id, project_id)
);
