# Workspace Overview — architecture review (cross-repo)

Status: **Normative.** This is the full cross-repo review the CLI-half review
(`orun` `specs/orun-workspace-overview/architecture-review.md`) defers to. The
CLI-half findings (A1–A3, B) are mirrored there and grounded against CLI code;
this file is the authoritative record and adds the platform-half findings (P-*).

The epic is sound: the `Repo` entity and the overview bytes ride the **existing**
catalog-snapshot push (`objremote.Sync` + `AdvanceCatalogHead`) with no new wire
call and no provider coupling; docs ride the existing `blob` closure. The findings
below are where a spec stated the system more cleanly than the code behaves.

## Cross-repo findings (mirrored in the CLI half)

### A1 — the `Repo` ref must not be minted from an un-normalized CLI string
`CatalogSnapshot.Repo` is a verbatim passthrough (no host/scheme/lowercase
normalization). Keying a cross-repo contract off it makes ad-hoc CLI formatting the
contract. **Resolution (adopted, `model.md §1a`):** the `Repo` entity_ref is the
repo-local `<namespace>/<repo>/<name>`; the platform keys `repo_facet` on
`(org_id, source_project_id)` and stores `entity_ref` for display/dedup only.

### A2 — adding `Repo` is emit-path + graph work, not an `allEntityKinds` poke
Array-driven kind validation is a one-liner, but a declared kind that carries
relations needs an emit path (`System`/`Domain` are *derived* — nothing to reuse)
and graph wiring. **Resolution:** WO3 scoped as "register + emit + relate" — landed.

### A3 — "read the doc at HEAD" is really "read the working tree"; make the pin real
`plan --push-catalog` can run on a dirty tree, so pushed bytes could diverge from
the `sha`/commit the provenance advertises. **Resolution (`model.md §3a`):** the CLI
reads bytes from the git object at the resolved commit, or refuses on a dirty tree.
The platform trusts `doc_ref.{sha,digest}` accordingly.

### B — docs ride the `blob` closure; no new object kind (RESOLVED)
Snapshot constituents already travel as `blob`/`tree` closure objects; a
`docs.overview` file is just another content-addressed `blob` that `doc_ref.digest`
locates. `blob` is legal since `250_state_refs`; GC is closure-based
(`gc-reachability.ts`). **No new object kind, no CHECK migration, no WO3↔WO4
ordering** (`model.md §0`). A `doc` kind bought only storage attribution
(recoverable via a `digest → size` join) — rejected.

## Platform-half findings

### P1 — project the facet by scope id, keep the doc a blob
WO4 must key `repo_facet` on `(org_id, source_project_id, COALESCE(env,''))` — the
same keystone as `330_state_org_catalog_index` — and store the overview `digest`,
**not** the bytes. Copying markdown into a column duplicates the object store,
breaks the single-source/GC story, and re-introduces a "content in the DB" surface
`18-state.md` forbids. The bytes stay a `blob`, read by digest (`model.md §6`).

### P2 — reuse the object GET for the doc; do not add a doc endpoint
The overview is read through the existing tenant-scoped object GET
(`handlers/objects.ts`), which already 404s cross-tenant digests and enforces
`state.object.read`. A bespoke `/overview` or `/doc` endpoint would re-implement
scoping/auth and invite a console-authored override — both rejected (`model.md §6`).
The read edge assembles; it does not store.

### P3 — projection is idempotent scope-replace, including the empty case
The `Repo` branch must delete+upsert exactly one facet per scope and **clear** the
scope's facet when a snapshot carries no `Repo` entity — otherwise a repo that
removes its `repo:` block leaves a stale front page. Mirror the
`org_catalog_entities` delete-then-upsert; a snapshot is the whole truth for its
scope.

### P4 — WO2 must degrade with no facet data
WO2 ships before WO4, so the landing route must render from
projects-as-repos with an empty overview state and never hard-depend on
`repo_facet`. This keeps the front door live while the projection lands and matches
the catalog portal's graceful-degradation discipline.

## What does not change
No new wire call; no `run`-path change; no scope/auth change; no provider
integration — docs are pushed bytes, never fetched. No console-authored content and
no `/overview` endpoint. See `README.md` scope boundary and `model.md §5–§6`.
