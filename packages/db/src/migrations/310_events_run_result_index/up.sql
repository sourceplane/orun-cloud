-- 310_events_run_result_index: keyset index for the run-result write-back driver.
--
-- Context: events
-- Epic: saas-orun-platform v2 (OV5) / saas-integrations IG9 write-back bridge.
--       The state-worker run-result driver (the outbound half's trigger) drains
--       terminal run events from events.event_log globally, in time order, in
--       bounded batches per cron tick, and posts a Check Run back to the linked
--       GitHub repo. Without a type-scoped keyset index that drain would scan the
--       whole (high-volume) event log every tick. This partial index makes the
--       scan O(batch) regardless of total event volume — the same scalability
--       keystone the scm.* consumer uses (event_log_run_result_idx mirrors
--       event_log_scm_ingest_idx).
--
-- Additive, index-only (no schema change). The predicate is an IMMUTABLE IN over
-- string literals, so it is legal in a partial index. Only the two TERMINAL run
-- results are covered — state.run.created (a start, nothing to post) is excluded
-- so it never widens the scan.

CREATE INDEX IF NOT EXISTS event_log_run_result_idx
  ON events.event_log (occurred_at, id)
  WHERE type IN ('state.run.completed', 'state.run.failed');
