-- Event grouping activation + group-aware notification ledger
-- (saas-event-streaming ES4).
-- Context: events
-- Idempotent: seed insert uses ON CONFLICT DO NOTHING; CREATE TABLE IF NOT
-- EXISTS. Additive; same-context FK only.
--
-- ES0 created the event_groups / event_group_members read-model tables; this
-- migration brings the correlation feature live:
--   * seeds the 'grouping' subscriber lane (active) — the events-worker
--     dispatcher's grouping handler renders catalog dedup keys and maintains
--     the open-story-per-key read-model. Alphabetical lane ordering means
--     'grouping' drains before 'notifications' each tick, but the two do not
--     share state (see below), so ordering is not a correctness dependency.
--   * creates events.rule_group_notifications — the notifications lane's OWN
--     ledger for group-aware firing. Keyed (rule_id, group_key), it records
--     the max severity already notified for a story so a rule fires on a
--     group's FIRST matching event and on severity ESCALATION, but not on
--     every member ("one story, not five pings"). Because this ledger belongs
--     solely to the notifications lane (the grouping lane never touches it),
--     the firing decision is race-free regardless of lane dispatch order.

INSERT INTO events.subscriber_lanes (lane_key, owner_context, description, type_filter, status, batch_size)
VALUES (
  'grouping',
  'events',
  'Dedup/correlation grouping (saas-event-streaming ES4). Renders catalog dedup keys and maintains events.event_groups as an open-story-per-key read-model.',
  '[]'::jsonb,
  'active',
  100
)
ON CONFLICT (lane_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS events.rule_group_notifications (
  rule_id               TEXT        NOT NULL
                                    REFERENCES events.notification_rules(id) ON DELETE CASCADE,
  group_key             TEXT        NOT NULL,
  max_notified_severity TEXT        NOT NULL
                                    CHECK (max_notified_severity IN ('info', 'notice', 'warning', 'error', 'critical')),
  first_notified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, group_key)
);

COMMENT ON TABLE events.rule_group_notifications IS
  'Group-aware notification ledger (ES4) — per (rule, dedup group key) high-water severity already notified; fires once per story plus on escalation. Owned solely by the notifications lane.';
