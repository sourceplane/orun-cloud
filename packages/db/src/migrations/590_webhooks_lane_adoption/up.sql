-- Webhooks lane adoption (saas-event-streaming ES1).
-- Context: events
-- Idempotent: seed inserts use ON CONFLICT DO NOTHING; re-running changes
-- nothing.
--
-- ES0 laid the shared lane substrate (580_event_streams_foundation); this
-- migration brings it live for the first two lanes:
--
--   * 'webhooks'      — the shipped B5 outbound fan-out. Delivery mechanics
--                       stay entirely in webhooks-worker; only the cursor
--                       storage moves to the events-owned shared table.
--   * 'notifications' — the ES2 rules-evaluation lane, registered PAUSED so
--                       the events-worker dispatcher ships dark: registering
--                       the lane is schema truth, running it is an ES2 code
--                       decision.
--
-- The cursor backfill copies the live per-org webhooks dispatch positions
-- from webhooks.webhook_dispatch_cursor into events.lane_cursors. This is a
-- one-time, one-directional data copy INTO the events context as part of the
-- R6 cutover protocol (copy -> dual-read -> cutover -> drop later); it is not
-- a cross-context foreign key, and the legacy table is left intact as the
-- dual-read fallback + rollback path. Any (org) cursor row created by an
-- old-code worker between migrate and deploy is covered at runtime by the
-- repository's read-through fallback to the legacy table.

INSERT INTO events.subscriber_lanes (lane_key, owner_context, description, type_filter, status, batch_size)
VALUES
  (
    'webhooks',
    'webhooks',
    'Outbound webhook fan-out (B5). Delivery, signing, retries, and replay live in webhooks-worker; the lane row shares only the cursor contract.',
    '[]'::jsonb,
    'active',
    100
  ),
  (
    'notifications',
    'events',
    'Notification-rule evaluation (saas-event-streaming ES2). Paused until the rules engine lands; the events-worker dispatcher skips paused lanes.',
    '[]'::jsonb,
    'paused',
    100
  )
ON CONFLICT (lane_key) DO NOTHING;

INSERT INTO events.lane_cursors (lane_key, org_id, last_event_id, last_occurred_at, updated_at)
SELECT subscriber_lane, org_id, last_event_id, last_occurred_at, now()
FROM webhooks.webhook_dispatch_cursor
WHERE subscriber_lane = 'webhooks'
ON CONFLICT (lane_key, org_id) DO NOTHING;
