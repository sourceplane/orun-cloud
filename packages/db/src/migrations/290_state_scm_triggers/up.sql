-- 290_state_scm_triggers: scm.* trigger projection + ingestion cursor (OV4).
--
-- Context: state
-- Epic: saas-orun-platform v2 (OV4 — the GitHub App bridge, inbound). The
--       state-worker consumes scm.push / scm.pull_request.* from events.event_log
--       and records a normalized TriggerOccurrence projection here: a durable,
--       queryable "what happened in this repo" surface (the console activity
--       feed / PR list) that is independent of — and a precursor to — object-
--       graph materialization (the catalog authorship, decided separately).
--
-- Design (design-v2 §5; bridge-to-state.md):
--   * Idempotent by the SOURCE event id: each events.event_log row is recorded
--     at most once (uq_state_triggers_event), so redeliveries / reprocessing are
--     safe no-ops. The consumer is therefore at-least-once with dedup =
--     effectively-once.
--   * Tenant isolation: org_id (+ optional project_id) denormalized; queries
--     scope by org. project_id is resolved from the repo's workspace link on
--     ingest and may be null (an org-level trigger for an as-yet-unlinked repo).
--   * The cursor is the consumer's bounded-work keystone: a single high-water
--     mark (occurred_at, event_id) so each cron tick scans only new events.
--   * No object bytes here — this is the coordination/projection plane.
--   * Idempotent DDL: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS state.triggers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL,
  project_id        UUID,                          -- resolved from the link; null = org-level
  provider          TEXT NOT NULL,                 -- 'github'
  provider_repo_id  TEXT NOT NULL,                 -- rename-stable repo id
  repo_full_name    TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('push', 'pull_request')),
  action            TEXT,                          -- PR action (opened/updated/merged/closed); null for push
  ref               TEXT,                          -- refs/heads/main
  commit_sha        TEXT NOT NULL,                 -- head/after sha
  base_sha          TEXT,                          -- PR base sha (Merkle diff bound); null for push
  pr_number         INTEGER,
  actor_login       TEXT,                          -- pusher / PR author login
  event_id          TEXT NOT NULL,                 -- events.event_log id (provenance + idempotency)
  status            TEXT NOT NULL DEFAULT 'recorded',  -- later: 'materialized' once the object graph ingests it
  occurred_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE state.triggers IS 'Normalized scm.* trigger projection (OV4): one row per source-control event, recorded idempotently from events.event_log by the state-worker bridge consumer. The activity/PR feed; a precursor to object-graph materialization.';

-- Idempotency keystone: each source event recorded once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_triggers_event
  ON state.triggers (event_id);

-- Activity feed: keyset pagination by scope, newest first. project_id is folded
-- to '' so org-level (null project) triggers collate as a first-class scope.
CREATE INDEX IF NOT EXISTS idx_state_triggers_scope
  ON state.triggers (org_id, COALESCE(project_id::text, ''), occurred_at DESC, id DESC);

-- Latest trigger per (repo, ref) — drives "current head per branch/PR" views.
CREATE INDEX IF NOT EXISTS idx_state_triggers_repo_ref
  ON state.triggers (org_id, provider, provider_repo_id, ref, occurred_at DESC, id DESC);

-- ── Ingestion cursor (the consumer's bounded-work high-water mark) ──
-- A single row (id = 'default'): the (occurred_at, event_id) of the last scm.*
-- event the consumer processed. Each cron tick reads events strictly after it,
-- so per-tick work is O(batch), not O(total events).
CREATE TABLE IF NOT EXISTS state.scm_ingest_cursor (
  id                TEXT PRIMARY KEY DEFAULT 'default',
  last_occurred_at  TIMESTAMPTZ,
  last_event_id     TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE state.scm_ingest_cursor IS 'High-water mark for the OV4 scm.* ingestion consumer: (occurred_at, event_id) of the last processed events.event_log row, so each cron tick scans only new events.';
