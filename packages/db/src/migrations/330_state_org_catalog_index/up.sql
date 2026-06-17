-- 330_state_org_catalog_index: org-global catalog projection read model (OV6).
--
-- Context: state
-- Epic: saas-orun-platform v2 (OV6 — org-global catalog projection, DV7;
--       reframes the old OP7 per-project entity stub). design-v2 §6: the default
--       catalog view is ONE org-wide component graph across all projects.
--       state.catalog_heads stay the immutable per-(project, environment) publish
--       pointers (write path, history, rollback); on head-advance the snapshot's
--       entities are INDEXED HERE with provenance (source project, environment,
--       commit). "Repo" is a provenance FILTER over this merged graph, not a
--       storage partition.
--
-- Derived, never authored: like state.catalog_entities, these rows are projected
-- from the snapshot blob and are idempotently rebuildable — the platform never
-- edits catalog content. The state-worker projector (OV6 next increment) walks
-- the pushed object-model tree and upserts here on catalog.head.advanced.
--
-- Namespaced by source to stay collision-free: the SAME entity_ref can appear
-- from different projects (or the same project across environments), so the
-- identity is (org, source_project, source_environment, entity_ref) — presented
-- merged, with provenance carried on every row for filtering and display.
--
-- Idempotent DDL: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS state.org_catalog_entities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL,
  entity_ref          TEXT NOT NULL,            -- stable entity ref, e.g. 'component:default/api'
  kind                TEXT NOT NULL,            -- Component | API | Resource | System | Domain | Group | …
  name                TEXT NOT NULL,
  owner               TEXT,
  lifecycle           TEXT,
  relations           JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{type, targetRef}]
  -- Provenance (the merged-graph filters + display): where this entity came from.
  source_project_id   UUID NOT NULL,
  source_environment  TEXT,                     -- null = the project-wide head
  source_commit       TEXT,                     -- git commit the snapshot was resolved at
  head_digest         TEXT NOT NULL,            -- the snapshot digest this row was projected from
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE state.org_catalog_entities IS 'Org-global catalog projection (OV6): one row per entity per (source project, environment) scope, projected idempotently from the catalog snapshot on head-advance. The merged org-wide component graph; provenance (project, env, commit) is carried per row so repo/env are filters, not partitions. Derived, never authored.';

-- Idempotent projection keystone: one row per entity within a (project,
-- environment) source scope. COALESCE folds the null (project-wide) environment
-- to '' so it collates as a first-class scope and ON CONFLICT can target it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_org_catalog_entities_ref
  ON state.org_catalog_entities (org_id, source_project_id, COALESCE(source_environment, ''), entity_ref);

-- Org-global browse, newest first (keyset paginated on created_at, id).
CREATE INDEX IF NOT EXISTS idx_state_org_catalog_entities_scope
  ON state.org_catalog_entities (org_id, created_at DESC, id DESC);

-- Provenance filter: a repo/project's component sublist.
CREATE INDEX IF NOT EXISTS idx_state_org_catalog_entities_project
  ON state.org_catalog_entities (org_id, source_project_id, created_at DESC, id DESC);

-- Facet filters: by kind / by owner.
CREATE INDEX IF NOT EXISTS idx_state_org_catalog_entities_kind
  ON state.org_catalog_entities (org_id, kind);
CREATE INDEX IF NOT EXISTS idx_state_org_catalog_entities_owner
  ON state.org_catalog_entities (org_id, owner);
