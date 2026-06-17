-- 300_state_link_bijection: project == repo bijection flip (OV2.2).
--
-- Context: state
-- Epic: saas-orun-platform v2 (OV2 — materialized tenancy, strict flip). OV2.1
--       added the rename-stable provider identity additively; this is the
--       deferred "flip to strict once data is clean" step (implementation-plan
--       OV2): the REVERSE of uq_state_workspace_link_remote — at most one ACTIVE
--       link per (org, project), making "a project is a repo" a true bijection
--       (DV4). 220 already enforced one active link per (org, remote_url); this
--       closes the other direction.
--
-- Self-healing backfill: a plain partial-unique index would fail if a project
-- already had two active links (e.g. a repo re-pointed). So FIRST deactivate the
-- older duplicates (keep the most recent active per (org, project)), THEN add
-- the index — the design's "backfill lone links, then flip" done atomically and
-- idempotently. On a clean table the backfill is a no-op.

-- Backfill: keep the newest active link per (org, project); unlink the rest.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY org_id, project_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
    FROM state.workspace_links
   WHERE status = 'active'
)
UPDATE state.workspace_links w
   SET status = 'unlinked', updated_at = now()
  FROM ranked
 WHERE w.id = ranked.id AND ranked.rn > 1;

-- The project == repo bijection: at most one active link per (org, project).
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_workspace_link_project_active
  ON state.workspace_links (org_id, project_id)
  WHERE status = 'active';
