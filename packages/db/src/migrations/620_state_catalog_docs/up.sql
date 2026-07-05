-- 620_state_catalog_docs: the org-wide catalog doc index (saas-catalog-docs CD3).
--
-- Context: state
-- Why: saas-workspace-overview shipped ONE doc (docs.overview) on ONE kind's
--   surface; the CLI (saas-catalog-docs CD1/CD2) now walks a bounded DOC SET
--   (the reserved overview + ordered, role-tagged pages) into the catalog
--   closure for EVERY entity kind — components, the Repo self-description, and
--   enriched derived kinds (System/Domain/Group/Environment). The console's
--   browse surfaces (Docs hub, entity Docs tab, Overview docs card) need an
--   org-wide "list the docs" read that doesn't unnest JSONB across the whole
--   entity table. This table is that index: one row per ATTACHED doc
--   (digest-bearing; declared-only entries stay visible on the entity JSON but
--   are not browsable — there is nothing to read).
--
-- Written in the same delete-then-upsert projection pass as
-- state.org_catalog_entities (catalog-projection.ts), so it can never diverge
-- from the entity rows, and it inherits the migration-570 outbox + cron sweep
-- for reconciliation. Derived, never authored; additive + idempotent.
--
-- The digest index also serves the doc-read authorization resolve
-- (findCatalogDocProject): GET …/catalog/doc?digest= serves only digests the
-- org's read model references — page bodies now resolve exactly like overview
-- bodies (model.md §5b).

CREATE TABLE IF NOT EXISTS state.catalog_docs (
  id                 UUID NOT NULL,
  org_id             UUID NOT NULL,
  source_project_id  UUID NOT NULL,
  source_environment TEXT,
  entity_ref         TEXT NOT NULL,             -- e.g. component:acme/repo/api (the row's parent entity)
  entity_kind        TEXT NOT NULL,             -- denormalized for kind-filtered browse
  entity_name        TEXT NOT NULL,
  doc_key            TEXT NOT NULL,             -- 'overview' | page key (slug)
  title              TEXT NOT NULL,             -- authored, or derived from the doc's H1 at resolve
  role               TEXT NOT NULL DEFAULT 'guide',  -- 'overview' | 'guide' | 'runbook' | 'architecture' | … (free slug)
  path               TEXT NOT NULL,             -- repo-relative source path (provenance/view-source)
  commit_sha         TEXT,                      -- the commit the bytes were read at (null = no git state at resolve)
  digest             TEXT NOT NULL,             -- CAS content address; the render key (body read from R2 by digest)
  size_bytes         INTEGER,
  position           INTEGER NOT NULL DEFAULT 0, -- declared order (overview = 0)
  head_digest        TEXT NOT NULL,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE state.catalog_docs IS 'Org-wide catalog doc index (saas-catalog-docs CD3): one row per attached (digest-bearing) doc of every catalog entity — the overview + docs.pages set. Projected from the snapshot in the same pass as org_catalog_entities (delete-then-upsert per scope; swept by the migration-570 outbox). Derived, never authored. digest is the CAS content address the console reads the body by; path/commit_sha are provenance.';

-- Scope identity: one row per (org, project, env, entity, doc key) — the doc's
-- stable identity across content changes (reader URLs address (entity, key)).
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_catalog_docs_scope
  ON state.catalog_docs (org_id, source_project_id, COALESCE(source_environment, ''), entity_ref, doc_key);

-- The Docs hub browse: kind chips + role chips over an org.
CREATE INDEX IF NOT EXISTS ix_state_catalog_docs_browse
  ON state.catalog_docs (org_id, entity_kind, role);

-- The doc-read authorization resolve: digest → owning project, org-scoped.
CREATE INDEX IF NOT EXISTS ix_state_catalog_docs_digest
  ON state.catalog_docs (org_id, digest);

-- Keyset pagination (created_at, id) — the platform's pagedList idiom.
CREATE INDEX IF NOT EXISTS ix_state_catalog_docs_page
  ON state.catalog_docs (org_id, created_at DESC, id DESC);
