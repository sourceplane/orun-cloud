-- 370_state_catalog_portal_fields: git-authored portal fields on the org catalog
-- projection (saas-catalog-portal CP4 / orun-catalog-portal CPF).
--
-- Context: state
-- Epic: saas-catalog-portal (CP4). The catalog portal design surfaces three
--       human-facing, GIT-AUTHORED fields the projection did not yet carry:
--       description (one-line summary), system (the group-by-system key), and
--       language (implementation language), plus free-form tags. orun's
--       objcatalog now projects these (CPF0); the state-worker projector reads
--       them from the snapshot blob and indexes them here so the console can
--       display them.
--
-- Derived, never authored: these remain projected from the snapshot, rebuildable
-- on head-advance like every other column. Additive + nullable, so older rows
-- (and snapshots that omit the fields) simply read null and the console degrades.
--
-- Idempotent DDL: ADD COLUMN IF NOT EXISTS throughout.

ALTER TABLE state.org_catalog_entities
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS system      TEXT,
  ADD COLUMN IF NOT EXISTS language    TEXT,
  ADD COLUMN IF NOT EXISTS tags        JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN state.org_catalog_entities.description IS 'Git-authored one-line summary, projected from the snapshot (catalog-portal CP4). Null when the source declares none.';
COMMENT ON COLUMN state.org_catalog_entities.system IS 'Git-authored system (the design''s group-by-system key), projected from spec.system. Null when absent (the console derives a fallback).';
COMMENT ON COLUMN state.org_catalog_entities.language IS 'Git-authored implementation language / runtime, projected from the snapshot. Null when absent.';
COMMENT ON COLUMN state.org_catalog_entities.tags IS 'Git-authored free-form tags ([]string as JSONB), projected from the snapshot.';

-- Facet filter: group/browse by system.
CREATE INDEX IF NOT EXISTS idx_state_org_catalog_entities_system
  ON state.org_catalog_entities (org_id, system);
