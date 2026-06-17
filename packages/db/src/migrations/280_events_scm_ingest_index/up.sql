-- 280_events_scm_ingest_index: keyset index for the scm.* ingestion consumer.
--
-- Context: events
-- Epic: saas-orun-platform v2 (OV4) / saas-integrations IG8 bridge. The
--       state-worker scm.* ingestion consumer (OV4) drains source-control events
--       from events.event_log globally, in time order, in bounded batches per
--       cron tick. Without a type-scoped keyset index that drain would scan the
--       whole (high-volume) event log every tick. This partial index makes the
--       scan O(batch) regardless of total event volume — the scalability
--       keystone of the consumer.
--
-- Additive, index-only (no schema change). The predicate `type LIKE 'scm.%'` is
-- IMMUTABLE, so it is legal in a partial index and future scm.* types are
-- covered automatically.

CREATE INDEX IF NOT EXISTS event_log_scm_ingest_idx
  ON events.event_log (occurred_at, id)
  WHERE type LIKE 'scm.%';
