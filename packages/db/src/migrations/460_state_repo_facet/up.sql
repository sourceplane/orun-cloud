-- 460_state_repo_facet: repo self-description facet + doc_ref pointers
-- (saas-workspace-overview WO4).
--
-- Context: state
-- Epic: saas-workspace-overview (WO4). Two additive, derived-never-authored
--       projections written on catalog.head.advanced alongside the existing
--       org_catalog_entities upsert:
--
--   1. state.org_catalog_entities.doc_ref — a nullable {path,ref,sha,digest}
--      pointer to the entity's docs.overview blob in CAS. The digest is the
--      content address; the body is read from R2 by digest. No state.objects.kind
--      change — docs ride the existing `blob` kind (the CLI pushes them as blobs
--      in the catalog closure).
--
--   2. state.repo_facet — one row per (org, project): the repo's self-description
--      projected from the declared Repo entity (display name, description, owner,
--      links, tags, its doc_ref). Keyed by project (the join key), so it never
--      needs the entity ref string. Drives the Git Repos list and the Workspace
--      Overview identity.
--
-- Derived, never authored: both are projected from the snapshot and rebuilt on
-- every head advance, like every other read-model column. Additive + idempotent
-- (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS); older snapshots that
-- carry neither simply leave doc_ref null and write no repo_facet row.

ALTER TABLE state.org_catalog_entities
  ADD COLUMN IF NOT EXISTS doc_ref JSONB;

COMMENT ON COLUMN state.org_catalog_entities.doc_ref IS 'Nullable {path,ref,sha,digest} pointer to the entity''s docs.overview blob in CAS (saas-workspace-overview WO4). digest = the content address (the body is read from R2 by digest); path/ref/sha are provenance. Projected from the snapshot; null when the entity declares no overview.';

CREATE TABLE IF NOT EXISTS state.repo_facet (
  org_id            UUID NOT NULL,
  source_project_id UUID NOT NULL,
  display_name      TEXT,
  description       TEXT,
  owner             TEXT,
  default_branch    TEXT,
  links             JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags              JSONB NOT NULL DEFAULT '[]'::jsonb,
  doc_ref           JSONB,
  entity_ref        TEXT,
  head_digest       TEXT NOT NULL,
  source_commit     TEXT,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, source_project_id)
);

COMMENT ON TABLE state.repo_facet IS 'Per-(org,project) repo self-description, projected from the declared Repo entity in the catalog snapshot (saas-workspace-overview WO4). Derived, never authored; delete-then-upsert on catalog.head.advanced. Keyed by project so the Git Repos list and Workspace Overview identity join by project, not by the entity ref.';
