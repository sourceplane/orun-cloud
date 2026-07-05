-- Team notification subject-kind lift (teams-collaboration TC1).
-- Context: notifications
-- Spec: specs/epics/teams-collaboration
--
-- TC1 makes a Team a first-class notification target and (with TC2) a
-- team-default preference level. Both the stored preference key and the
-- recipient subject kind are constrained to ('user','organization') today —
-- this widens each to admit 'team':
--
--   * notification_preferences.subject_kind — so a team-default preference row
--     is storable (member-override → team-default → org-default cascade, TC2),
--   * notifications.recipient_subject_kind — so a delivery row may record a
--     team provenance directly (the enqueue fan-out records per-member 'user'
--     rows today, but a direct team row must remain representable without a
--     further migration).
--
-- Idempotent: DROP CONSTRAINT IF EXISTS before each re-add (mirrors the ES3
-- channel lift in 610_notification_channels). Additive; no cross-context FKs;
-- every existing ('user','organization') row continues to validate.

-- ── Preference subject-kind lift: ('user','organization') → +('team') ──
ALTER TABLE notifications.notification_preferences
  DROP CONSTRAINT IF EXISTS notification_prefs_subject_kind_check;
ALTER TABLE notifications.notification_preferences
  ADD CONSTRAINT notification_prefs_subject_kind_check
    CHECK (subject_kind IN ('user', 'organization', 'team'));

-- ── Recipient subject-kind lift: NULL | ('user','organization') → +('team') ──
ALTER TABLE notifications.notifications
  DROP CONSTRAINT IF EXISTS notifications_recipient_subject_kind_check;
ALTER TABLE notifications.notifications
  ADD CONSTRAINT notifications_recipient_subject_kind_check
    CHECK (recipient_subject_kind IS NULL
           OR recipient_subject_kind IN ('user', 'organization', 'team'));
