-- Notification-rule throttle state + notifications lane activation
-- (saas-event-streaming ES2).
-- Context: events
-- Idempotent: CREATE TABLE IF NOT EXISTS; the lane UPDATE is a no-op when the
-- lane is already active.
--
-- Storm control is a mandatory rule field (design §5, R1): every rule carries
-- throttle_window_seconds/throttle_max, and this table is the small upsert
-- ledger the matching engine consumes them through — one row per rule, a
-- fixed window anchored at the first fire, fired_count monotone within the
-- window. Consumption is a single atomic upsert (no read-modify-write), so
-- overlapping cron ticks cannot double-admit.
--
-- The 'notifications' lane was seeded PAUSED in 590_webhooks_lane_adoption so
-- the ES1 dispatcher would ship dark. ES2 ships the lane handler (the rules
-- engine), so the lane goes active in the same change that makes running it
-- meaningful. Operators can still pause it at any time via
-- subscriber_lanes.status — this UPDATE only flips the seeded paused state
-- and never runs again once recorded in the migrations ledger.

CREATE TABLE IF NOT EXISTS events.rule_throttle_state (
  rule_id           TEXT        PRIMARY KEY
                                REFERENCES events.notification_rules(id) ON DELETE CASCADE,
  window_started_at TIMESTAMPTZ NOT NULL,
  fired_count       INTEGER     NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE events.rule_throttle_state IS
  'Per-rule fixed-window throttle ledger — consumed atomically by the notifications lane handler.';

UPDATE events.subscriber_lanes
SET status = 'active', updated_at = now()
WHERE lane_key = 'notifications' AND status = 'paused';
