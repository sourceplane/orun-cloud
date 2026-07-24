-- saas-integrations-console IX2: per-connection capability preferences.
--
-- Additive, nullable. `capability_prefs` is a free-form `{capabilityId: boolean}`
-- blob recording which of the provider's console-surfaced capability toggles the
-- operator enabled for this connection (e.g. GitHub pull_requests/checks/
-- deployments/issues). Absent (NULL) means "all defaults" — the console applies
-- the default-on posture, so pre-IX2 rows need no backfill.
ALTER TABLE integrations.connections
  ADD COLUMN IF NOT EXISTS capability_prefs jsonb;
