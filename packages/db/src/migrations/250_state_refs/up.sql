-- 250_state_refs: Hosted RefStore — the L2 mutable pointer layer (OV1).
--
-- Context: state
-- Epic: saas-orun-platform v2 (OV1) — re-anchors Orun Cloud as a hosted object
--       model: ObjectStore (state.objects + R2, already shipped) + RefStore
--       (this migration) + the ModelReader index. The CLI/TUI consume the
--       hosted store through the SAME object-model readers they use locally
--       (orun internal/objmodel), so "the console and the TUI share one read
--       path" is literally true — they differ only in whether the stores point
--       at .orun/ on disk or at this hosted bucket + ref table.
--
-- Design rules (specs/epics/saas-orun-platform/design-v2.md §2,
-- orun/specs/orun-object-model/object-store.md §6):
--   * A ref is the only mutable, authoritative surface over the immutable object
--     graph: a name → ObjectID pointer, updated by compare-and-swap. Unlike
--     catalog_heads (history retained, append-only), a ref is a single mutable
--     row per (org, project, name) — the git-ref model: advancing is an in-place
--     CAS, not a new history row.
--   * Ref names are logical paths: refs/sources|catalogs|revisions|executions/*
--     (the store adds no prefix here — the full logical name is stored).
--   * The pointed-at object must exist in state.objects first (the writer uploads
--     a ref's full closure, then moves the ref last). A composite FK enforces it,
--     tenant-safe (mirrors catalog_heads → objects).
--   * Tenant isolation: org_id + project_id NOT NULL, denormalized; every query
--     scopes by org_id (house rule).
--   * Idempotent: IF NOT EXISTS throughout for Supabase autocommit safety.
--
-- Also widens state.objects.kind to admit the object model's two STRUCTURAL
-- kinds (blob, tree) alongside the four semantic kinds, so the hosted plane can
-- store the content-addressed objects the CLI's RemoteStore uploads (each named
-- by the hash of its framed serialization — same id local and remote).

-- ── Admit structural object kinds (blob, tree) ──────────────
-- The object model addresses two structural kinds; the four semantic kinds
-- (plan, catalog-snapshot, …) stay. Drop+re-add the inline CHECK by its
-- generated name (Postgres names a column CHECK <table>_<col>_check).
ALTER TABLE state.objects DROP CONSTRAINT IF EXISTS objects_kind_check;
ALTER TABLE state.objects
  ADD CONSTRAINT objects_kind_check
  CHECK (kind IN ('plan', 'catalog-snapshot', 'composition-lock', 'artifact-manifest', 'blob', 'tree'));

-- ── Refs (mutable CAS pointers; the L2 layer) ───────────────
-- One row per (org, project, name). target is an object id ('<algo>:<hex>',
-- i.e. 'sha256:<hex>') that must exist in state.objects. updated_at + writer
-- record the last CAS mover. There is intentionally no history table: refs are
-- the heads, and the immutable object graph IS the history.
CREATE TABLE IF NOT EXISTS state.refs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  name          TEXT NOT NULL,                   -- logical ref name, e.g. 'catalogs/current'
  target        TEXT NOT NULL,                   -- 'sha256:<hex>' → state.objects
  writer        TEXT,                            -- last CAS writer: cli|runner|tui|saas|github
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (org_id, project_id, target)
    REFERENCES state.objects (org_id, project_id, digest)
);

COMMENT ON TABLE state.refs IS 'Hosted RefStore (OV1): mutable name → ObjectID pointers over the immutable object graph, updated by compare-and-swap. The heads of refs/sources|catalogs|revisions|executions per (org, project). Target must exist in state.objects.';

-- One row per (org, project, name) — the CAS keystone (create-if-absent and
-- conditional advance both pivot on this unique key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_refs_name
  ON state.refs (org_id, project_id, name);

-- Prefix listing (refs/sources/*, refs/executions/by-id/*) scoped to a tenant,
-- name-ordered so the list endpoint returns a stable, sorted page.
CREATE INDEX IF NOT EXISTS idx_state_refs_prefix
  ON state.refs (org_id, project_id, name);
