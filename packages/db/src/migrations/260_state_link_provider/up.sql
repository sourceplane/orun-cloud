-- 260_state_link_provider: Workspace link provider identity (OV2.1).
--
-- Context: state
-- Epic: saas-orun-platform v2 (OV2 — materialized tenancy, additive slice).
--       "Project == repo, 1:1." Federation between Orun's own workspace links
--       (state.workspace_links, any git host) and the GitHub App's repo links
--       (integrations.repo_links) must match on a RENAME-STABLE provider repo
--       id, never on owner/name (a repo rename or transfer keeps its id but
--       changes its path). This migration records that identity.
--
-- Additive ONLY (design-v2 §3 / implementation-plan-v2 OV2: "additive migration
-- first; backfill provider IDs and lone links; flip to NOT NULL/strict once data
-- is clean"). The (org_id, project_id) WHERE active BIJECTION index is the
-- strict flip and is deliberately deferred to a later migration so it cannot
-- fail on existing rows before a backfill. Here every column is nullable and the
-- new index is partial on a non-null provider id, so this is safe on live data.

-- Rename-stable provider identity. provider is the SCM host family
-- ('github'|'gitlab'|…); provider_repo_id is the host's stable numeric/opaque
-- repo id; the owner id/login are the account facts (login is display-only,
-- never matched on).
ALTER TABLE state.workspace_links ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE state.workspace_links ADD COLUMN IF NOT EXISTS provider_repo_id TEXT;
ALTER TABLE state.workspace_links ADD COLUMN IF NOT EXISTS provider_owner_id TEXT;
ALTER TABLE state.workspace_links ADD COLUMN IF NOT EXISTS provider_owner_login TEXT;

COMMENT ON COLUMN state.workspace_links.provider_repo_id IS 'Rename-stable SCM repo id; federation with integrations.repo_links matches on (provider, provider_repo_id), never owner/name.';

-- Federation lookup: resolve an active link by its rename-stable repo identity
-- (the OIDC/credential-agnostic auth path in OV3 keys CI trust on this). Partial
-- on a present provider_repo_id so App-less links (no provider id yet) don't
-- bloat the index.
CREATE INDEX IF NOT EXISTS idx_state_workspace_links_provider_repo
  ON state.workspace_links (provider, provider_repo_id)
  WHERE status = 'active' AND provider_repo_id IS NOT NULL;
