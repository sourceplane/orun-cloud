# Workspace Overview (platform half) — implementation plan

WO2, WO4, WO5 — each a self-contained, verifiable PR on `main`. **Verification
gate (every milestone):** `pnpm typecheck` + `pnpm lint` + `pnpm test` green.
Milestone numbering is cross-repo and fixed (`README.md`); WO3 is the CLI half
(landed in `orun`); WO6 (`Product`) is deferred.

Sequencing: **WO2 ships first** (needs nothing from WO3/WO4 — it lands the route and
degrades). **WO4** then lands the projection + facet + read. **WO5** wires the
render onto real data. WO2 and WO4 are independent; WO5 depends on both.

## WO2 — Workspace Overview landing route

- `apps/web-console-next/src/app/(app)/orgs/[orgSlug]/page.tsx`: render the
  workspace overview (replace the current redirect/placeholder), wrapped in
  `OrgScope`.
- `apps/web-console-next/src/components/workspace/workspace-overview.tsx`: the
  shell — header, a repos section sourced from projects, and an empty
  "no overview authored yet" state. Reuse `components/ui/*` tokens and the
  catalog surface's primitives.
- No contract/DB/state-worker change. Degrades with zero facet data.

**Done when:** `/orgs/{slug}` renders the workspace overview shell (not a bare
redirect); with no `repo_facet` data it shows the repos list + empty overview
state; `pnpm typecheck && pnpm lint && pnpm test` green.

## WO4 — projection + `repo_facet` + read

1. **Migration** `packages/db/src/migrations/38x_state_repo_facet/up.sql`: the
   `state.repo_facet` table + `uq_state_repo_facet_scope` unique index
   (`design.md §2a`, columns per `model.md §4a`). One-way `up.sql`, `IF NOT
   EXISTS`, header comment. No `objects_kind` CHECK change.
2. **Contracts** `packages/contracts`: `RepoFacet` type + `UpsertRepoFacetInput`
   (displayName, description, tags, owner, links, overview {path,sha,digest},
   provenance). SDK read method if the console reads via SDK.
3. **Repository** `packages/db/src/state/`: `upsertRepoFacet`,
   `deleteRepoFacetForScope`, `getRepoFacet`, `listRepoFacets(orgId)` — mirror the
   `org_catalog_entity` methods + types.
4. **Projection** `apps/state-worker/src/catalog-projection.ts`: recognize
   `kind === "Repo"` in `collectEntities()`; in `projectCatalogSnapshot()`
   delete+upsert the scope's `repo_facet` alongside `org_catalog_entities`
   (idempotent scope-replace; zero `Repo` → clear). Store the overview `digest`;
   do not copy bytes (`model.md §6`).
5. **Facet read handler** `apps/state-worker/src/handlers/`: return facet(s) for a
   scope for the console (`design.md §2c`). Overview bytes are read by the console
   via the existing object GET — no new doc endpoint (`design.md §2d`).

**Done when:** a projection test pushes a snapshot with a `Repo` entity +
`docs.overview` blob and asserts exactly one `repo_facet` row carrying
`{path,sha,digest}`; a snapshot with no `Repo` clears the scope's facet;
re-projection is idempotent; the facet read returns it; the overview digest
resolves through the object GET; gate green.

## WO5 — console render (read-edge assembled)

- Wire `workspace-overview.tsx` (WO2) onto real data: `listRepoFacets` /
  `getRepoFacet` for identity/owner/links/tags; fetch the overview markdown by
  `overview_digest` via the object GET and render it client-side (sanitized).
- Workspace facets (repo/entity counts, last push, recent runs, health) — degrade
  honestly where a runtime signal has no source.
- Deep-links into `/orgs/{slug}/catalog` and project runs/environments.

**Done when:** with a real facet + overview blob, the page renders the repo
identity + the authored markdown + facets; a missing/absent overview digest shows
the graceful empty state; render tests cover both paths; gate green.

## Compatibility & sequencing notes

- **Additive & order-free with the CLI.** Doc blobs ride the existing `blob` kind;
  an older platform ignored them, and WO4 can project snapshots the CLI already
  pushed (`model.md §0/§5`). No WO3↔WO4 release ordering.
- **WO2 is off the critical path.** It lands behind a page that degrades to the
  repos list; WO4 lights it up; WO5 finishes the render.
- **`Product` (WO6) is out of scope** — when scoped, it adds `product_facet` +
  namespace-scoped merge + primary-repo selection (`model.md §7`).
