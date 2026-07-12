-- 800_messaging_lane: seed the messaging reaction lane (IH3).
--
-- Context: events
-- Epic: saas-integration-hub (IH3, design §4.3) — the events-worker lane that
--       reacts to the Slack drain's messaging.* emissions:
--         * messaging.action.invoked / mute_rule → 1h rule suppression (the
--           existing ES7 storm cooldown clears it — no new machinery);
--         * messaging.channel.archived → dependent slack_app notification
--           channels flip to disabled (internal notifications-worker call).
--       "Events + rules are the composition points": the drain never holds a
--       reverse service binding; this lane row is what turns its emissions
--       into platform reactions.
--
-- type_filter '[]' = all types (the handler narrows), matching the grouping
-- and notifications lane rows. Idempotent (ON CONFLICT DO NOTHING).

INSERT INTO events.subscriber_lanes (lane_key, owner_context, description, type_filter, status, batch_size)
VALUES (
  'messaging',
  'events',
  'Messaging reactions (saas-integration-hub IH3). Consumes messaging.* from the Slack inbox drain: mute_rule actions suppress rules for the storm cooldown (1h); channel-archived events disable dependent slack_app notification channels.',
  '[]'::jsonb,
  'active',
  100
)
ON CONFLICT (lane_key) DO NOTHING;
