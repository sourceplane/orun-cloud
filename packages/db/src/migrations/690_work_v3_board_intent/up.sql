-- 690_work_v3_board_intent: folded board-intent cache columns (orun-work-v3 PM2).
--
-- Context: work
-- Epic: orun-work v3 (specs/epics/orun-work-v3/) — additive over
--       660_work_v3_intent_plane.
--
-- What lands (design.md §1.3): the two remaining folded-intent cache columns
-- on work.tasks that the PM2 mutators fold from labeled/unlabeled and
-- related/unrelated events —
--   * tags       JSONB — sorted string array of free-form workspace labels
--   * relations  JSONB — [{rel: blocks|parent|relates, target}] typed edges;
--     the fold derives Blocked from open `blocks` relations exactly as from
--     contract Deps (a flag, never a rung)
--
-- Like every envelope column these are DROPPABLE: rebuilt from the
-- coordination log alone (invariant 1; rebuildCaches proves it). 660 already
-- landed priority/estimate/cycle_key and the work.views table this milestone
-- writes. NO STORED FACT: nothing here stores a rung, a progress number, or
-- an ordering the fold could not replay (V3-3).

ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS tags      JSONB;
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS relations JSONB;
