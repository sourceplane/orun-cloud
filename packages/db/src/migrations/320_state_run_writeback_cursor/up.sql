-- 320_state_run_writeback_cursor: high-water mark for the run-result write-back driver.
--
-- Context: state
-- Epic: saas-orun-platform v2 (OV5) / saas-integrations IG9 write-back bridge.
--       The state-worker drives the outbound write-back proxy off TERMINAL run
--       events (state.run.completed / state.run.failed): each cron tick reads the
--       events strictly after this cursor, resolves the run's linked repo, and
--       POSTs a Check Run back to GitHub via integrations-worker. This single-row
--       cursor is the consumer's bounded-work keystone — exactly like
--       state.scm_ingest_cursor for the inbound bridge — so per-tick work is
--       O(batch), not O(total run events).
--
-- The driver advances this cursor PER EVENT (not once per batch): a Check Run
-- POST is not idempotent on GitHub's side, so on a crash mid-batch we must resume
-- AFTER the last event we already acted on, never re-post it. A single high-water
-- row makes that resume point durable and cheap.
--
-- Idempotent DDL: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS state.run_writeback_cursor (
  id                TEXT PRIMARY KEY DEFAULT 'default',
  last_occurred_at  TIMESTAMPTZ,
  last_event_id     TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE state.run_writeback_cursor IS 'High-water mark for the OV5/IG9 run-result write-back driver: (occurred_at, event_id) of the last terminal run event the driver posted back to GitHub, so each cron tick scans only new events and never re-posts after a crash.';
