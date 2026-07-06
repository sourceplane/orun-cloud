-- Event lifecycle: retention sweep support + per-rule storm breaker state
-- (saas-event-streaming ES7).
-- Context: events
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- throughout. Additive; same-context references only; no DROP.
--
-- ES7 hardens the pipeline for scale and lifecycle:
--   * The retention sweep (events-worker off-peak cron) enforces
--     limit.event_retention_days on events.event_log / events.audit_entries
--     with the design §10 security-category floor, and ages dead letters +
--     closed groups out on fixed platform windows. The cutoff deletes are
--     batched keyset scans; the columns/indexes below back the scans that the
--     ES0/ES4 indexes did not already cover.
--   * The per-rule circuit breaker (R1) auto-suppresses a rule after sustained
--     throttle saturation. suppressed_at is the storm-breaker overlay on top of
--     the operator-set status column: a rule is effectively active when
--     status = 'enabled' AND suppressed_at IS NULL. The read maps
--     suppressed_at IS NOT NULL back onto the 'suppressed' status the ES6 rules
--     page already renders; a cooldown clears it and resumes firing.

-- ---------------------------------------------------------------------------
-- Storm-breaker state on notification rules. suppressed_at/suppressed_reason
-- are the auto-suppression overlay; saturated_window_count/last_saturated_at
-- are the consecutive-saturation bookkeeping the throttle admission path
-- maintains (reset to 0 on an admitted firing, incremented on a denied one).
-- ---------------------------------------------------------------------------
ALTER TABLE events.notification_rules
  ADD COLUMN IF NOT EXISTS suppressed_at          TIMESTAMPTZ;
ALTER TABLE events.notification_rules
  ADD COLUMN IF NOT EXISTS suppressed_reason      TEXT;
ALTER TABLE events.notification_rules
  ADD COLUMN IF NOT EXISTS saturated_window_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events.notification_rules
  ADD COLUMN IF NOT EXISTS last_saturated_at      TIMESTAMPTZ;

-- Currently-suppressed rules: the cooldown re-enable scan (suppressed_at <
-- cutoff) and the admin rule-storm audit both filter on suppressed_at, and the
-- working-set query now also excludes suppressed rows. A small partial index
-- keeps those O(suppressed), not O(rules).
CREATE INDEX IF NOT EXISTS notification_rules_suppressed_idx
  ON events.notification_rules (suppressed_at)
  WHERE suppressed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Retention cutoff-scan indexes.
--
-- event_log (org_id, occurred_at) cutoff deletes are already backed by
-- event_log_org_occurred_idx (org_id, occurred_at DESC, id DESC); audit_entries
-- likewise by audit_entries_org_occurred_idx. No new index is added for those.
--
-- The two fixed-platform-window sweeps below are NOT covered by an existing
-- index, so we add a partial index for each:
--   * dead letters: terminal-status rows older than the platform window, all
--     orgs — the existing dead_letters indexes key on (org_id, ...) or the OPEN
--     partial, neither of which backs a global terminal-status age scan.
--   * closed groups: status = 'closed' AND closed_at < cutoff — event_groups
--     indexes key on (org_id, last_at) / the open partial-unique, neither of
--     which backs a closed_at age scan.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS dead_letters_terminal_updated_idx
  ON events.dead_letters (updated_at)
  WHERE status IN ('replayed', 'discarded');

CREATE INDEX IF NOT EXISTS event_groups_closed_at_idx
  ON events.event_groups (closed_at)
  WHERE status = 'closed';

COMMENT ON COLUMN events.notification_rules.suppressed_at IS
  'Storm-breaker auto-suppression timestamp (ES7). NULL = not suppressed; a rule fires only when status = ''enabled'' AND suppressed_at IS NULL. Cleared after the cooldown window elapses.';
