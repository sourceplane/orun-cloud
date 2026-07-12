-- 740_slack_app_channels: the slack_app delivery channel kind (IH2).
--
-- Context: notifications
-- Epic: saas-integration-hub (IH2) — ES's ChannelProvider seam gains the
--       `slack_app` kind beside `slack_incoming_webhook` (which keeps working
--       untouched). A slack_app channel's config_ciphertext stores a
--       REFERENCE — {connectionId, channelExternalId, channelName} — never a
--       credential; the bot token stays in integrations-worker custody and is
--       fetched per send over the internal service binding (design §4.2).
--
--       slack_group_messages is the event-group ↔ Slack message identity map
--       behind the chat.update upgrade: the first post per (channel, group)
--       records the message ts; subsequent group fires edit that message in
--       place, plus a thread reply on severity escalation. Rows carry message
--       COORDINATES (channel id + ts), never message content or credentials.
--
-- Idempotent as a unit: the kind CHECK swap is guarded, the table is
-- CREATE IF NOT EXISTS.

-- 1) Widen the channel-kind CHECK to admit slack_app.
ALTER TABLE notifications.notification_channels
  DROP CONSTRAINT IF EXISTS notification_channels_kind_check;
ALTER TABLE notifications.notification_channels
  ADD CONSTRAINT notification_channels_kind_check
  CHECK (kind IN ('slack_incoming_webhook', 'slack_app'));

-- 2) Event-group → Slack message identity (one story, one message).
CREATE TABLE IF NOT EXISTS notifications.slack_group_messages (
  channel_id UUID NOT NULL
    REFERENCES notifications.notification_channels(id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  -- Slack coordinates of the story's root message (chat.update target).
  slack_channel TEXT NOT NULL,
  slack_ts TEXT NOT NULL,
  -- High-water severity rendered on the root message (escalation display).
  last_severity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, group_key)
);
