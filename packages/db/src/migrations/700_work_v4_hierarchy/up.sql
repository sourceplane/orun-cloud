-- 700_work_v4_hierarchy: the planning hierarchy's intent plane (orun-work-v4 WH1).
--
-- Context: work
-- Epic: orun-work v4 (specs/epics/orun-work-v4/) — Initiative → Design →
--       Epic → Milestone → Task, additive over 660/690.
--
-- What lands (design.md §1):
--   * work.designs — droppable intent-envelope cache for the Design noun
--     (doc chain + sealed context + structured proposal), rebuilt from the
--     coordination log alone (invariant 1).
--   * work.milestones — droppable fold cache of milestone_edited events:
--     the epic-scoped checkpoint ladder (V4-D). Progress inside is DERIVED.
--   * The coordination-log kind CHECK regenerates to the 27-kind closed
--     vocabulary. The four decision kinds (approved / approval_revoked /
--     design_adopted / superseded) are HUMAN-ONLY at the model layer (V4-2);
--     there is STILL no delivery-lifecycle-write kind (WP-3) and the
--     observation CHECK does not change (V4-1).
--   * Envelope property columns, all pure intent (design §1.7):
--     work.tasks.milestone_key; work.specs.initiative_key + target_date;
--     work.initiatives.owner + target_date + success_criteria.
--
-- NO STORED FACT: nothing here stores a rung, an intent state, an approval
-- state, a progress number, or a health value — intent state and every
-- rollup (milestone progress, epic execution, initiative health) fold from
-- the logs at read (V4-3/V4-4). Approval is an `approved` coordination
-- event; there is deliberately no approved_* column anywhere.
--
-- work.doc_revisions.spec_key (660) now carries ANY documented subject key —
-- epics and designs share one digest form, one canonicalizer, and one
-- fork-visible-LWW policy (V4-6); the column name stays for compatibility.

-- ── Designs (envelope cache; the fourth item kind) ───────────────────────────

CREATE TABLE IF NOT EXISTS work.designs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  key           TEXT NOT NULL,                 -- DSG-n via work.sequences
  initiative    TEXT NOT NULL,                 -- hasDesign edge; exactly one
  title         TEXT NOT NULL,
  doc_ref       TEXT,                          -- latest revision (doc chain in work.doc_revisions)
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {catalog, coordSeq, obsSeq} — what the design assumed
  proposal      JSONB,                         -- {epics: [{slug, title, docSeed, milestones[], taskSkeletons[]}]}
  labels        JSONB,
  created_by    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, key)
);

CREATE INDEX IF NOT EXISTS idx_work_designs_initiative
  ON work.designs (org_id, initiative, created_at);

-- ── Milestones (fold cache of milestone_edited; epic-scoped, V4-D) ───────────

CREATE TABLE IF NOT EXISTS work.milestones (
  org_id        UUID NOT NULL,
  spec_key      TEXT NOT NULL,                 -- the epic
  key           TEXT NOT NULL,                 -- 'WH2' — epic-scoped, immutable
  ordinal       INT  NOT NULL,
  title         TEXT NOT NULL,
  goal          TEXT,
  done_when     JSONB,                         -- string[]
  target_date   DATE,
  removed       BOOLEAN NOT NULL DEFAULT false,

  PRIMARY KEY (org_id, spec_key, key)
);

-- ── The 27-kind coordination vocabulary (still no lifecycle-write kind) ─────

ALTER TABLE work.events DROP CONSTRAINT IF EXISTS work_events_kind_check;
ALTER TABLE work.events ADD CONSTRAINT work_events_kind_check CHECK (kind IN (
  'item_created', 'item_edited', 'contract_edited',
  'assigned', 'unassigned', 'comment_added',
  'ordered', 'pinned', 'canceled',
  'doc_edited',
  'reaction_added', 'reaction_removed',
  'labeled', 'unlabeled',
  'prioritized', 'estimated', 'cycle_set',
  'related', 'unrelated',
  'milestone_edited', 'milestone_set',
  'review_requested', 'review_submitted',
  'approved', 'approval_revoked',
  'design_adopted', 'superseded'));

-- ── Envelope property columns (nullable; folded from the log — invariant 1) ─

ALTER TABLE work.tasks       ADD COLUMN IF NOT EXISTS milestone_key    TEXT;
ALTER TABLE work.specs       ADD COLUMN IF NOT EXISTS initiative_key   TEXT;
ALTER TABLE work.specs       ADD COLUMN IF NOT EXISTS target_date      DATE;
ALTER TABLE work.initiatives ADD COLUMN IF NOT EXISTS owner            TEXT;
ALTER TABLE work.initiatives ADD COLUMN IF NOT EXISTS target_date      DATE;
ALTER TABLE work.initiatives ADD COLUMN IF NOT EXISTS success_criteria JSONB;
