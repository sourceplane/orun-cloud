-- Notification channels + async-retry scaffolding (saas-event-streaming ES3).
-- Context: notifications
-- Spec: specs/components/14-notifications.md, specs/epics/saas-event-streaming
--
-- ES2 shipped rule-routed EMAIL delivery. ES3 opens the channel-provider seam:
--   * a new notifications.notification_channels table holding per-org channel
--     config (the Slack incoming-webhook URL, AES-GCM encrypted exactly like a
--     webhook endpoint secret — write-only, never returned on CRUD reads),
--   * the channel CHECK lift from ('email') to ('email','slack') across the
--     three channel-bearing tables (attempts has no channel column), so slack
--     notifications, preferences, and suppressions are storable,
--   * async-retry columns on notifications (next_retry_at + attempt_count) so
--     the new notifications-worker cron can drain and re-send failed rows on
--     the webhooks-style backoff ladder — the synchronous enqueue send becomes
--     attempt zero; a failure with retries remaining schedules next_retry_at.
--
-- Idempotent: CREATE ... IF NOT EXISTS; DROP CONSTRAINT IF EXISTS before each
-- re-add; ADD COLUMN IF NOT EXISTS. Additive; no cross-context FKs.

-- ── Channel config (encrypted) ─────────────────────────────
-- One row per configured delivery channel. config_ciphertext holds the
-- AES-GCM CiphertextEnvelope (JSON) of the bearer credential (Slack incoming
-- webhook URL). It is NEVER selected on CRUD read paths — only the internal
-- send path decrypts it (mirrors webhooks.webhook_endpoints.secret_ciphertext).

CREATE TABLE IF NOT EXISTS notifications.notification_channels (
  id                UUID        PRIMARY KEY,
  org_id            UUID        NOT NULL,
  kind              TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  config_ciphertext TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'active',
  last_verified_at  TIMESTAMPTZ,
  created_by        UUID        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_channels_kind_check
    CHECK (kind IN ('slack_incoming_webhook')),
  CONSTRAINT notification_channels_status_check
    CHECK (status IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_channels_org_name_idx
  ON notifications.notification_channels (org_id, lower(name));

CREATE INDEX IF NOT EXISTS notification_channels_org_created_idx
  ON notifications.notification_channels (org_id, created_at DESC, id DESC);

COMMENT ON TABLE notifications.notification_channels IS
  'Per-org delivery channel config (ES3). config_ciphertext is an AES-GCM '
  'CiphertextEnvelope of a bearer credential (Slack webhook URL); write-only, '
  'never returned on CRUD reads — only the internal send path decrypts it.';

COMMENT ON COLUMN notifications.notification_channels.config_ciphertext IS
  'AES-GCM CiphertextEnvelope (JSON). Bearer credential — MUST NOT be echoed '
  'on any API response, log line, event payload, or audit entry.';

-- ── Channel CHECK lift: ('email') → ('email','slack') ──────
ALTER TABLE notifications.notification_preferences
  DROP CONSTRAINT IF EXISTS notification_prefs_channel_check;
ALTER TABLE notifications.notification_preferences
  ADD CONSTRAINT notification_prefs_channel_check
    CHECK (channel IN ('email', 'slack'));

ALTER TABLE notifications.notifications
  DROP CONSTRAINT IF EXISTS notifications_channel_check;
ALTER TABLE notifications.notifications
  ADD CONSTRAINT notifications_channel_check
    CHECK (channel IN ('email', 'slack'));

ALTER TABLE notifications.notification_suppressions
  DROP CONSTRAINT IF EXISTS notification_suppressions_channel_check;
ALTER TABLE notifications.notification_suppressions
  ADD CONSTRAINT notification_suppressions_channel_check
    CHECK (channel IN ('email', 'slack'));

-- ── Async retry scaffolding on notifications ───────────────
-- next_retry_at: when set (and status='failed'), the row is retry-pending and
-- the cron drain will re-send at/after that time. Cleared (NULL) on terminal
-- success or exhausted retries. attempt_count: monotone across all attempts
-- (the synchronous enqueue send is attempt 1).
ALTER TABLE notifications.notifications
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE notifications.notifications
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

-- Retry drain index: retry-pending rows ordered by due time (partial, tiny).
CREATE INDEX IF NOT EXISTS notifications_retry_idx
  ON notifications.notifications (next_retry_at)
  WHERE status = 'failed' AND next_retry_at IS NOT NULL;
