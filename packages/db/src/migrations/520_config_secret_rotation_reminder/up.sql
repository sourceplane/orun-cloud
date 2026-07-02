-- 520_config_secret_rotation_reminder: rotation/expiry reminder bookkeeping (SEC7).
--
-- Context: config
-- Epic: saas-secret-manager (SEC7, pairs orun-secrets SD-3 / platform-integration
--       §3). The rotation/expiry cron scans config.secret_metadata for secrets
--       whose rotation_policy interval has elapsed (overdue) or whose expires_at
--       falls inside the lead window, and emits an alert-worthy
--       secret.rotation_due / secret.expiring event per due secret so the console
--       + notifications layer can act. To stay idempotent — one reminder per
--       secret per suppression window rather than one every cron tick — the sweep
--       stamps last_reminded_at after it emits, and the due-query excludes rows
--       reminded within the window. This column is that stamp.
--
-- No secret value is involved: this is pure reminder bookkeeping over metadata.
--
-- Additive + idempotent (mirrors 470/480/500/510 guarded style).

ALTER TABLE config.secret_metadata
  ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;

COMMENT ON COLUMN config.secret_metadata.last_reminded_at IS
  'When the SEC7 rotation/expiry cron last emitted a reminder for this secret. '
  'NULL = never reminded. The sweep stamps this after emitting and its due-query '
  'excludes rows reminded within the suppression window, so a still-overdue '
  'secret is not re-notified every tick. Reminder bookkeeping only — no value.';

-- Partial index over the reminder-eligible population: rows that carry a rotation
-- policy or an expiry are the only candidates the cron scans. Keeps the periodic
-- due-scan O(candidates) rather than a full table sweep.
CREATE INDEX IF NOT EXISTS secret_metadata_rotation_due_idx
  ON config.secret_metadata (last_reminded_at)
  WHERE status = 'active' AND (rotation_policy IS NOT NULL OR expires_at IS NOT NULL);
