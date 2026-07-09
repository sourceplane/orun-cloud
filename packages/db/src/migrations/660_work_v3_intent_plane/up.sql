-- 660_work_v3_intent_plane: the project surface's intent plane (orun-work-v3 PM0).
--
-- Context: work
-- Epic: orun-work v3 (specs/epics/orun-work-v3/) — Linear-class PM on the
--       truth engine, additive over 560_work_foundation_v2.
--
-- What lands (design.md §1):
--   * work.doc_revisions — append-only, content-addressed cloud document
--     bodies. The digest form equals v2's imported doc_ref (`sha256:<hex>`,
--     V3-2), so specs cache one doc_ref column for both sources.
--   * work.initiatives — droppable intent-envelope cache (like specs/tasks),
--     rebuilt from the coordination log alone (invariant 1).
--   * work.cycles / work.views — authored intent nouns; handlers arrive in
--     PM3/PM2, the tables land here so the plane ships once.
--   * The coordination-log kind CHECK regenerates to the 19-kind closed
--     vocabulary. Every addition is intent or conversation (V3-1); there is
--     STILL no lifecycle-write kind (WP-3) — the observation CHECK does not
--     change in this epic.
--   * Nullable folded-intent cache columns on work.tasks (priority /
--     estimate / cycle_key), unused until the PM2 mutators fold them.
--
-- NO STORED FACT: nothing here stores a rung, a progress number, or a
-- burn-up point — those remain derived (V3-3).

-- ── Initiatives (envelope cache; the third item kind) ────────────────────────

CREATE TABLE IF NOT EXISTS work.initiatives (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  key           TEXT NOT NULL,                 -- slug
  title         TEXT NOT NULL,
  description   TEXT,
  created_by    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, key)
);

-- ── Cloud document revisions (content, not envelope) ─────────────────────────

CREATE TABLE IF NOT EXISTS work.doc_revisions (
  org_id        UUID NOT NULL,
  revision      TEXT NOT NULL,                 -- 'sha256:<hex>' of the canonical body
  parent        TEXT,                          -- prior revision; forks stay visible
  spec_key      TEXT NOT NULL,
  body          TEXT NOT NULL,                 -- markdown, CRLF normalized to LF
  created_by    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_work_doc_revisions_spec
  ON work.doc_revisions (org_id, spec_key, created_at);

-- ── Cycles (authored time-boxes; progress inside is derived, never stored) ──

CREATE TABLE IF NOT EXISTS work.cycles (
  org_id        UUID NOT NULL,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  starts_at     DATE NOT NULL,
  ends_at       DATE NOT NULL,
  created_by    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, key)
);

-- ── Saved views (pure UI intent, shareable by default) ──────────────────────

CREATE TABLE IF NOT EXISTS work.views (
  org_id        UUID NOT NULL,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  config        JSONB NOT NULL,                -- {layout, filters, groupBy, order}
  created_by    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, key)
);

-- ── The 19-kind coordination vocabulary (still no lifecycle-write kind) ─────

ALTER TABLE work.events DROP CONSTRAINT IF EXISTS work_events_kind_check;
ALTER TABLE work.events ADD CONSTRAINT work_events_kind_check CHECK (kind IN (
  'item_created', 'item_edited', 'contract_edited',
  'assigned', 'unassigned', 'comment_added',
  'ordered', 'pinned', 'canceled',
  'doc_edited',
  'reaction_added', 'reaction_removed',
  'labeled', 'unlabeled',
  'prioritized', 'estimated', 'cycle_set',
  'related', 'unrelated'));

-- ── Folded-intent cache columns (nullable; PM2 folds them from the log) ─────

ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS priority  TEXT;
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS estimate  NUMERIC;
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS cycle_key TEXT;
