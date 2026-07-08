# saas-catalog-docs — Implementation plan

Status: Draft (CD0 in review). Each milestone lists its repo and a concrete
**done when**. Phasing follows the WO lesson: **no cross-repo release
coupling anywhere** — pages ride the existing `blob` kind, so the CLI can ship
before the platform projects (unreferenced page blobs are inert), and the
platform can ship before any CLI in the wild declares a page (the projector
simply finds no `pages`).

- **Phase 1 — the CLI carries the doc set** (`orun` alone). CD1 generalizes the
  walk the WO code already does for `Repo` to every emitted entity, adds
  `pages`, commit provenance, the pinned-commit read, and caps. CD2 adds the
  enrichment block. Nothing user-visible changes in the console yet; pushed
  snapshots simply carry more.
- **Phase 2 — the platform indexes and renders** (`orun-cloud` alone). CD3
  projects the doc index; CD4 makes the entity Docs tab real; CD5 ships the
  hub + reader + nav + Overview card.
- **Phase 3 — polish and deferred.** CD6 sibling links + staleness; CD7
  deferred (full-text, scorecard signal, Product docs).

Landing order: **CD0 → CD1 → CD3 → CD4 → CD5**; CD2 is independent after CD1;
CD6/CD7 later. A slip in any milestone holds nothing earlier hostage.

---

## CD0 — Design + decision lock (all repos) · 🔵 In review

This epic (`README.md`, `model.md`, `design.md`, this plan,
`risks-and-open-questions.md`), the WO post-ship review
(`../saas-workspace-overview/review-2026-07-05.md`), the `orun` mirror
(`specs/orun-catalog-docs/`), and the ogpic adoption note.

**Done when:** all three repos carry their halves; `model.md §0`'s decision
table is ratified; the WO review's finding→milestone mapping is agreed.

---

## Phase 1 (`sourceplane/orun`)

### CD1 — The doc set: `docs.pages`, universal walk, provenance, caps

The step-by-step lives in `orun`'s `specs/orun-catalog-docs/implementation-plan.md`;
the platform-relevant output:

1. **Struct:** `DocPage {Path, Key, Title, Role}` + `Pages []DocPage` on the
   shared docs structs (`ComponentDocs`/`EntityDocs`/`ComponentYAMLDocs`,
   `internal/catalogmodel/entity_envelope.go`). Validation per `model.md §2a`
   (slugs, reserved `overview`, unique keys, ≤ 24 pages).
2. **Universal walk (closes WO F1):** populate `nodes.Entity.PendingDocs` for
   **every** emitted entity carrying docs — the component path
   (`objplan/catalog.go` component mapping + `docsBlock`) and the `Repo` path
   alike. The assembly seam (`nodes/assemble.go:451-477`) is already generic
   and unchanged.
3. **Provenance + pinned read (closes WO F3/F4):** resolve the head commit at
   attach time; read bytes from the git object at that commit; refuse
   (path-pointer-only + logged warning) on dirty/untracked paths; stamp
   `commit` on every attached ref (`model.md §2b/§2d`). Keep the deprecated
   `sha` on `overview` for wire compat.
4. **Caps (closes WO Q4):** 256 KiB/doc · 24 pages/entity · 8 MiB/closure;
   over-cap ⇒ skip + logged warning; never fails the plan.
5. **CLI read surface:** `orun catalog docs <entity>` lists the doc set
   (key · title · role · path · digest state); `--key <k>` prints one body
   (extends the shipped WO3.1 `catalog docs` command).

**Done when:** `orun plan` on a repo where a component declares two pages and
the repo declares one yields a snapshot whose entity JSONs carry
`docs.pages[].{key,title,role,path,commit,digest,size}`; unchanged re-push
uploads zero doc bytes; a dirty page path attaches nothing and logs why; an
over-cap doc attaches nothing and logs why; `orun catalog docs` round-trips.

### CD2 — Enrichment: `catalog.entities` (closes WO F6)

1. Parse `catalog.entities` (`intent.yaml`): keys `<kind>/<name>`, kinds
   `system|domain|group|environment` at v1; fields `description`, `owner`,
   `links`, `tags`, `docs` (full doc-set struct).
2. Merge onto the **derived** entities during resolve — fill-empty for
   metadata, own the docs block; enrichment for a target that doesn't
   materialize ⇒ validation **warning**, never an entity ("enrich, never
   create").
3. Enriched docs walk the same CD1 pipeline (PendingDocs, provenance, caps).

**Done when:** a repo whose components reference `domain: identity` and whose
intent enriches `domain/identity` with a description + overview + one page
yields a `Domain` entity carrying them; removing the last component in that
domain removes the entity (warning about the orphaned enrichment); an
enrichment for `component/*` is rejected.

---

## Phase 2 (`sourceplane/orun-cloud`)

### CD3 — Projection: `state.catalog_docs` + contracts + list endpoint

1. **Migration** (`packages/db/src/migrations/`): `state.catalog_docs` per
   `model.md §4a` (unique scope index on the null-normalized environment,
   browse + digest indexes). Additive; no change to `org_catalog_entities` or
   `repo_facet`.
2. **Projector** (`apps/state-worker/src/catalog-projection.ts`): in the same
   delete-then-upsert pass as entities, emit one row per attached doc
   (`overview` + each `pages[]` entry **with a digest**), denormalizing
   `entity_kind`/`entity_name`. Inherits the `catalog_projection` outbox +
   sweep (migration `570`) for free — no new reconciliation machinery.
3. **Authorization resolve:** widen `findCatalogDocProject` (packages/db state
   repository) to match `state.catalog_docs.digest` (indexed) in addition to
   `doc_ref` — the shipped `GET …/catalog/doc?digest=…` then serves page
   bodies with the same tenant safety.
4. **Contracts + SDK + route:** `CatalogDoc` in `packages/contracts/src/state.ts`;
   `GET /v1/organizations/{org}/catalog/docs` in `state-facade.ts` +
   `state-worker/src/router.ts` + handler (filters + keyset per `model.md §5a`);
   `state.listCatalogDocs` in `packages/sdk/src/state.ts`.

**Done when:** pushing a CD1 snapshot yields `catalog_docs` rows matching the
declared set; re-projection (sweep + manual reproject) is idempotent; the list
endpoint filters by kind/role/entityRef/q and paginates; a page body reads by
digest cross-tenant-safely (foreign digest 404s); a pre-CD1 snapshot projects
zero doc rows and nothing breaks.

### CD4 — Entity Docs tab goes real (closes WO F2)

1. Fetch the entity's doc rows (`listCatalogDocs({entityRef})`) in the service
   page loader; body-by-digest on doc selection (immutable → cache by digest).
2. Replace `docsFor()`'s synthetic files (`lib/catalog-portal/page.ts:217-248`)
   with the real shelf; delete `genReadme`/`genArch`/`genRunbook`/`genApi`/
   `genProvision` as *doc* sources, keeping their fact tables only inside the
   badged **derived card** (`design.md §4`).
3. Digestless declarations render greyed with the not-attached reason; the
   no-docs state renders the derived card + manifest nudge.

**Done when:** an entity with attached docs shows exactly its git-authored set
with provenance lines; an entity without docs shows the badged derived card +
snippet (no fictional `README.md` anywhere in the product); the honesty rule
(`design.md §4`) holds on every path.

### CD5 — The Docs hub + reader + nav + Overview card

1. Routes: `app/(app)/orgs/[orgSlug]/docs/page.tsx` (hub) and
   `docs/[entityKey]/[docKey]/page.tsx` (reader); **Docs** nav item after
   Catalog (`components/shell/nav-items.ts`, icon `BookOpen`); breadcrumbs.
2. Hub per `design.md §2` (kind/role chips, search, grouped rows); reader per
   `design.md §3` (shelf rail, sanitized body, ToC, provenance + view-source).
   The shelf rail and reader body are shared components with CD4's tab.
3. Workspace Overview right rail: the docs card (`design.md §5`), hidden when
   only the overview exists.
4. Empty/first-run states per `design.md §6`.

**Done when:** the hub lists every attached doc org-wide with working filters
and search; reader deep links survive content changes (identity-addressed);
the Overview shows the docs card for a repo with pages; all four empty states
render; mobile behaves (same responsive pattern as the catalog portal).

---

## Phase 3

### CD6 — Cross-doc links + staleness polish

Sibling-link rewriting within the entity's doc set (`model.md §6`); "N commits
behind `<default-branch>`" on the provenance line when push events supply the
tip (the WO mechanism, now on every doc).

**Done when:** a relative link between two attached pages navigates in-reader;
an external link keeps the sanitized treatment; behind-count renders when the
platform knows the tip and disappears when it doesn't.

### CD7 — Deferred (each its own decision when real)

- **Full-text body search** — a tsvector projection over attached bodies
  (bounded by the caps); deliberately not at v1 (risks Q1).
- **Doc coverage as a scorecard signal** — "has overview / has runbook" feeding
  SC5 tiers.
- **`Product` docs** — the doc set applies to the `Product` kind unchanged when
  WO6 ships; the merge rule is risks Q3.

---

## Rollout / back-compat

- **Additive throughout.** Old CLIs push snapshots without `pages` → zero doc
  rows, today's behavior. New CLIs push pages to an old platform → inert blobs
  in the closure (legal since migration `250`), picked up when CD3 lands.
  A pre-CD3 console against a CD3 platform simply never calls the new endpoint.
- **No object-kind coordination, no migration ordering** beyond CD3's own
  additive migration.
- **ogpic adopts** (reference): declares `docs.pages` + a `domain` enrichment
  the first orun release carrying CD1/CD2; its pre-authored doc files land with
  CD0 so adoption is a manifest-only diff.
- **Reversibility:** every surface degrades to the WO baseline if `catalog_docs`
  is empty; deleting the nav item + routes restores today's console exactly.
