-- 340_projects_environment_activity (saas-orun-platform v2 OV9).
--
-- Environment lifecycle: archive an environment that is no longer pushed to.
--
-- An environment is materialized the first time a run/plan references it (OP4
-- env-registration) and otherwise carries no liveness signal — so the org-global
-- catalog and the console steadily accumulate environments that were used once
-- for a short-lived branch and then abandoned. OV9 archives those on a schedule:
-- an ACTIVE environment whose last activity predates a retention window is moved
-- to 'archived' (the same terminal state the manual DELETE produces), reversibly
-- — a fresh push revives it.
--
-- last_active_at is that liveness signal: bumped to now() on every activity
-- touch (the OV9.2 run-create seam calls the internal register endpoint), and
-- the stale-archival sweep selects ACTIVE rows whose last_active_at predates the
-- cutoff. Existing rows backfill to updated_at (their last known mutation) so the
-- sweep has a sane baseline; the column defaults to now() for new rows.
--
-- Additive + idempotent (IF NOT EXISTS / autocommit runner). Dormant until the
-- OV9.2 cron drives the sweep.

ALTER TABLE projects.environments
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- Set the default BEFORE backfilling so a concurrent insert during the window
-- gets now() (non-null) rather than tripping the SET NOT NULL below.
ALTER TABLE projects.environments
  ALTER COLUMN last_active_at SET DEFAULT now();

UPDATE projects.environments
   SET last_active_at = updated_at
 WHERE last_active_at IS NULL;

ALTER TABLE projects.environments
  ALTER COLUMN last_active_at SET NOT NULL;

COMMENT ON COLUMN projects.environments.last_active_at IS
  'Last time this environment was pushed to (a run/plan referencing it). Bumped on activity; the OV9 stale-archival sweep archives active rows whose last_active_at predates the retention window. A fresh push revives an archived row.';

-- Drives the stale-archival sweep: active rows ordered by liveness. Partial on
-- status = 'active' because archived rows are never swept. last_active_at leads
-- so the global cutoff scan (WHERE last_active_at < cutoff ORDER BY
-- last_active_at) uses it directly; org_id + project_id trail so the index also
-- covers tenant-scoped "environments by recency" reads without a heap fetch.
CREATE INDEX IF NOT EXISTS environments_active_last_active_idx
  ON projects.environments (last_active_at, org_id, project_id)
  WHERE status = 'active';
