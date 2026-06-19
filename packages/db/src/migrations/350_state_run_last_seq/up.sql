-- 350_state_run_last_seq — projector high-water mark (BM3).
--
-- The event-sourced coordinator (RunCoordinator DO) is the authority for run
-- coordination; Postgres is a delayed projection of its append-only log. last_seq
-- is the per-run high-water mark the projector guards its writes on: it applies a
-- folded snapshot iff last_seq < fold.lastSeq, making projection idempotent under
-- replay and out-of-order delivery. Defaults to 0 so existing (OP2-era) rows are
-- always behind the first DO fold and project cleanly on cutover.
ALTER TABLE state.runs
  ADD COLUMN IF NOT EXISTS last_seq BIGINT NOT NULL DEFAULT 0;
