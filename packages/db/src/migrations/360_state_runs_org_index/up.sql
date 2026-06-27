-- 360_state_runs_org_index: org-global runs feed keyset index (Activities).
--
-- Context: state
-- Epic: saas-orun-platform (console "Activities" surface — the org-global run
--       history, mirroring the org-global catalog browser OV6). The console
--       lists runs MERGED across every project in the org (newest first,
--       keyset-paginated on created_at, id), with the project/environment/
--       status/branch facets narrowing the merged feed rather than partitioning
--       it.
--
-- The existing idx_state_runs_project (org_id, project_id, created_at, id)
-- requires a project_id equality to be selective, so the all-repos org feed
-- would fall back to a scan. This adds the org-scoped twin: drop the project
-- column so the org-wide keyset list is index-ordered. The project-narrowed feed
-- (a single repo) keeps using idx_state_runs_project.
--
-- Idempotent DDL: IF NOT EXISTS.

-- Org-global runs browse, newest first (keyset paginated on created_at, id).
CREATE INDEX IF NOT EXISTS idx_state_runs_org
  ON state.runs (org_id, created_at DESC, id DESC);
