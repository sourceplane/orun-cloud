# Workspace Overview — platform design

The *how*, on the real seams. Read [`model.md`](./model.md) first for the *what*.
Every code path below is cited against the current tree so implementation lands on
existing structure, not an imagined one.

## 1. Data flow (end to end)

```
repo: docs/overview.md
  └─ orun catalog push (WO3) ── entities/Repo/<name>.json  (docs.overview={path,sha,digest})
                              └─ blob <digest> = overview bytes
        │ objremote.Sync → PUT /state/{org}/{proj}/objects/{digest}  (Orun-Object-Kind: blob)
        │ AdvanceCatalogHead → PUT /state/catalog/head
        ▼
  state-worker (WO4)
    handlers/catalog.ts  handleAdvanceCatalogHead → ctx.waitUntil(projection)
    catalog-projection.ts  collectEntities() walks entities/Repo/ →
        upsert state.repo_facet  (idempotent scope-replace)
        ▼
  console (WO5)
    /orgs/[orgSlug]  reads repo_facet(s) via SDK/contract read
    fetches overview markdown by digest: GET …/objects/{overview_digest}
    renders identity + owner + links + tags + markdown + facets   (read-edge assembled)
```

## 2. WO4 — projection + facet (the backend meat)

### 2a. `state.repo_facet` table (migration `38x_state_repo_facet`)

Follows the migrations convention (`packages/db/src/migrations/`, one-way `up.sql`,
`IF NOT EXISTS`, header comment, scope-unique index) — mirror
`330_state_org_catalog_index` and `370_state_catalog_portal_fields`. Columns per
`model.md §4a`. Scope keystone:

```sql
CREATE UNIQUE INDEX uq_state_repo_facet_scope
  ON state.repo_facet (org_id, source_project_id, COALESCE(source_environment, ''));
```

Keyed on `(org_id, source_project_id)` — **never** on the entity_ref string
(`model.md §1a`). No CHECK/`objects_kind` change (docs are `blob`, already legal).

### 2b. Projection branch (`apps/state-worker/src/catalog-projection.ts`)

`collectEntities()` already walks `entities/<Kind>/` and returns `ProjectedEntity[]`.
Add a **Repo** path:

- Recognize `kind === "Repo"`; extract `metadata.{displayName,description,tags}`,
  `ownership.owner`, `links[]`, and `docs.overview` (`{path,sha,digest}`).
- In `projectCatalogSnapshot()`, alongside the `org_catalog_entities`
  delete+upsert for the scope, **delete+upsert the one `repo_facet` row** for the
  scope (idempotent scope-replace, `model.md §4a`). Zero `Repo` entities → clear
  the scope's facet.
- The overview `blob` is **not** copied into a column — the digest is stored; the
  bytes stay in the object store (`model.md §6`).

Repository methods in `packages/db/src/state/`: `upsertRepoFacet`,
`deleteRepoFacetForScope`, `getRepoFacet`, `listRepoFacets(orgId)` — mirroring the
`org_catalog_entity` methods. Contracts: `RepoFacet` type + `UpsertRepoFacetInput`
in `packages/contracts` (+ SDK read if the console reads through the SDK).

### 2c. Facet read for the console

A read handler returning the repo facet(s) for a scope — either a dedicated
`GET /state/org/{orgId}/repos[?project=]` handler in `state-worker`, or extend the
existing org-catalog read the portal already uses. Prefer the smallest surface that
gives the console `listRepoFacets(orgId)` and `getRepoFacet(orgId, projectId)`.

### 2d. Overview doc read (no new storage path)

The console fetches the markdown by digest through the **existing** object GET
(`handlers/objects.ts` `handleGetObject`): tenant-scoped
`GET /v1/state/{orgId}/projects/{projectId}/objects/{overview_digest}`, which 404s
a cross-tenant digest and returns raw bytes with `orun-object-kind: blob`. No new
endpoint, no auth path — reuses `state.object.read` (`model.md §6`).

## 3. WO2 — the landing route

Add the workspace overview at the org landing: `apps/web-console-next/src/app/(app)/
orgs/[orgSlug]/page.tsx` (today a redirect/placeholder), rendering a
`components/workspace/workspace-overview.tsx`. Ship **first** and degrade: with no
`repo_facet` data yet (pre-WO4) it shows the workspace shell + repos-from-projects
with an empty/"no overview authored" state. Reuse `OrgScope` + the catalog surface's
tokens and primitives (`components/ui/*`, `components/catalog/*`). No dependency on
WO4/WO3 to land the route.

## 4. WO5 — render (read-edge assembled)

Assemble the page from the facet + the doc bytes (`model.md §6`):

- **Identity block** — displayName, description, owner, tags, links (reuse the
  `entity-overview.tsx` `Pair`/`dl` pattern).
- **Overview body** — fetch `overview_digest` via the object GET, render the
  markdown client-side (existing markdown renderer if present; else a minimal,
  sanitized one). Missing/absent digest → graceful "no overview authored".
- **Workspace facets** — repo/entity counts, last catalog push, recent run
  activity, health — degrade honestly where a runtime signal has no source
  (`saas-catalog-portal` graceful-degradation rules).
- Deep-link into `/orgs/{slug}/catalog` and the project runs/environments.

## 5. Verification

Per-milestone gate: `pnpm typecheck` + `pnpm lint` + `pnpm test` green (turbo).
WO4 adds a projection test: push a snapshot carrying a `Repo` entity + overview
blob → assert one `repo_facet` row with the doc_ref, a no-`Repo` snapshot clears
it, and re-projection is idempotent. WO5 renders against a fixture facet + a doc
blob and asserts the markdown + graceful-degradation paths.

## 6. What does NOT change

- No new object kind; docs ride `blob` (`model.md §0`).
- No new push wire call; the `Repo` entity + doc blob ride the existing catalog
  push (`model.md §5`).
- No `/overview` write endpoint, no console override (`model.md §6`).
- No provider integration; nothing is fetched from a git host.
- `Product` and multi-repo merge are deferred (`model.md §7`, WO6).
