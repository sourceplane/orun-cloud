-- 720_work_events_kind_check_repair: the coordination-log kind CHECK is ONE
-- constraint again (orun-work-v4 WH6 dogfood fix).
--
-- Context: work
--
-- The bug: 560 created work.events with an INLINE, unnamed CHECK on kind, so
-- Postgres auto-named it events_kind_check. The v3 (660) and v4 (700)
-- vocabulary regenerations both ran
--   DROP CONSTRAINT IF EXISTS work_events_kind_check
-- — the wrong name, a silent no-op — and then ADDED work_events_kind_check.
-- Production therefore enforces BOTH: the original 9-kind v2 CHECK and the
-- 27-kind v4 CHECK. Every insert must satisfy both, so every kind added
-- since v2 (doc_edited, prioritized, …, milestone_edited, approved, …) is
-- rejected with a check violation. Unnoticed until the first real v4 write
-- (the dogfood import's milestone phase) because the work repository's
-- Postgres path had no live consumer of the newer kinds.
--
-- The repair: drop BOTH names, re-add the canonical 27-kind constraint under
-- the name the regenerations expect. Idempotent as a unit (both drops are
-- IF EXISTS; the ADD always follows the drops). The vocabulary is exactly
-- 700's — this migration changes enforcement plumbing, not the model: still
-- no delivery-lifecycle-write kind (WP-3), and the observation CHECK is
-- untouched (V4-1).

ALTER TABLE work.events DROP CONSTRAINT IF EXISTS events_kind_check;
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
