-- 560_work_foundation_v2: the work lens — two append-only logs (orun-work v2 WP0).
--
-- Context: work
-- Epic: orun-work v2 (authoritative spec: orun repo specs/orun-work/;
--       cloud half: specs/epics/orun-work/). Supersedes the torn-down v1
--       schema (200_work_foundation, dropped by 490_work_teardown).
--
-- Design rules (design.md §8-§9, enforced here where SQL can):
--   * NO STORED FACT: there is no status/lifecycle/gate/released column
--     anywhere. Lifecycle is a derived query over the two logs (WP-3).
--   * Two logs only: work.events is the authored coordination log (mandatory
--     actor, closed 9-kind vocabulary); work.observations is the
--     world-authored fact log (named versioned source, closed 6-kind
--     vocabulary, dedupe_key idempotency — invariant 4).
--   * work.specs / work.tasks are droppable fold caches of the coordination
--     log (current intent envelopes): rebuild from work.events reproduces
--     them (invariant 1).
--   * Tenancy: workspace-scoped (WP-7) — org_id is the workspace's
--     organizations row; there is no project partition. Task keys allocate
--     per (org_id, prefix) via work.sequences.
--   * Idempotent: IF NOT EXISTS throughout for Supabase autocommit safety.

CREATE SCHEMA IF NOT EXISTS work;

-- ── Intent envelopes (fold caches of the coordination log) ─────────────────

CREATE TABLE IF NOT EXISTS work.specs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  key           TEXT NOT NULL,                 -- slug
  title         TEXT NOT NULL,
  doc_ref       TEXT,                          -- content-addressed doc body (digest)
  labels        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by    JSONB NOT NULL,                -- membership subject {type,id}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, key)
);

CREATE TABLE IF NOT EXISTS work.tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  key           TEXT NOT NULL,                 -- PREFIX-seq, per workspace
  spec_key      TEXT,                          -- partOf target; NULL = inbox
  title         TEXT NOT NULL,
  contract      JSONB,                         -- goal/affects/doneWhen/gates/designRefs/deps
  labels        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, key)
);

CREATE INDEX IF NOT EXISTS idx_work_tasks_spec
  ON work.tasks (org_id, spec_key)
  WHERE spec_key IS NOT NULL;

-- ── The coordination log (authored; the only mutable-feeling plane) ────────

CREATE TABLE IF NOT EXISTS work.events (
  event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  subject       TEXT NOT NULL,                 -- task or spec key
  kind          TEXT NOT NULL CHECK (kind IN (
                  'item_created', 'item_edited', 'contract_edited',
                  'assigned', 'unassigned', 'comment_added',
                  'ordered', 'pinned', 'canceled')),
  actor         JSONB NOT NULL,                -- {type,id,via?} — membership subject
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  seq           BIGINT NOT NULL,               -- per-workspace total order; the sync cursor

  -- Mandatory typed actor (invariant 3). There is deliberately NO
  -- lifecycle-write kind in the CHECK above: the category "someone asserts
  -- a rung" is unrepresentable at the schema level (WP-3).
  CONSTRAINT work_events_actor_typed CHECK (actor ->> 'type' IN ('user', 'agent', 'automation')),
  UNIQUE (org_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_work_events_subject
  ON work.events (org_id, subject, seq);

-- ── The observation log (world-authored; nobody's opinion) ─────────────────

CREATE TABLE IF NOT EXISTS work.observations (
  obs_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  source         TEXT NOT NULL,                -- github-webhook | run-stream | deploy-overlay | ci | import-backfill
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  kind           TEXT NOT NULL CHECK (kind IN (
                   'branch_seen', 'pr_opened', 'pr_merged', 'pr_closed',
                   'gate_result', 'revision_live')),
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  dedupe_key     TEXT NOT NULL,                -- idempotency: same fact twice ⇒ same fold
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  seq            BIGINT NOT NULL,              -- per-workspace total order (separate sequence)

  UNIQUE (org_id, seq),
  UNIQUE (org_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_work_observations_kind
  ON work.observations (org_id, kind, seq);

-- ── Sequence allocation ─────────────────────────────────────────────────────
-- Task keys per (org, PREFIX); the two log sequences ride reserved names
-- ('#events', '#observations') so allocation is one mechanism.

CREATE TABLE IF NOT EXISTS work.sequences (
  org_id        UUID NOT NULL,
  name          TEXT NOT NULL,                 -- 'ORN' | '#events' | '#observations'
  next_value    BIGINT NOT NULL DEFAULT 1,

  PRIMARY KEY (org_id, name)
);
