# Epic: saas-catalog-docs

> **Cross-repo epic.** Mirrored in **`sourceplane/orun-cloud`**
> (`specs/epics/saas-catalog-docs/`) and **`sourceplane/orun`**
> (`specs/orun-catalog-docs/`). The normative shared model — the `docs.pages`
> doc-set surface, the `catalog.entities` enrichment block, the wire shape, and
> the `state.catalog_docs` projection — is `model.md` here; the `orun` copy
> references it and owns the CLI half. Successor to
> [`saas-workspace-overview`](../saas-workspace-overview/) (**WO**), chartered
> by its post-ship review
> ([`review-2026-07-05.md`](../saas-workspace-overview/review-2026-07-05.md)).

**Every entity gets a shelf, not a page.** WO proved the spine — repo-authored
markdown travels as a content-addressed blob in the catalog snapshot and renders
by digest, with no git-provider coupling and no console authorship — then
exposed it through the narrowest possible aperture: **one doc, on one kind,
on one page**. Meanwhile the catalog's entity Docs tab papers over the gap with
markdown *synthesized from catalog fields and presented as repo files* — the one
surface where the platform's own "the console renders what git produced"
invariant is violated in spirit.

This epic finishes the model WO ratified: a **doc set on every catalog kind** —
`Repo`, `Component`, `API`, `Resource`, `System`, `Domain`, `Group`,
`Environment` (and WO6's `Product`, when it lands) — carried by the same blob
closure, projected into an org-wide **doc index**, and browsable in the console
as a first-class **Docs** surface: a workspace docs hub, a per-doc reader, and
an entity Docs tab that shows what git actually produced.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — design complete (CD0 in review); no code landed |
| Cluster | **CD** (catalog docs — the doc-object model + docs surfaces over **WO** `saas-workspace-overview`, **CP** `saas-catalog-portal`, **OP** `18-state.md`) |
| Repos | `sourceplane/orun-cloud` (platform, TS) · `sourceplane/orun` (CLI/engine, Go) · `sourceplane/ogpic` (reference adopter) |
| Owner(s) | `apps/state-worker` + `apps/web-console-next` + `packages/{contracts,sdk,db}` (platform) · `internal/{catalogmodel,catalogresolve,objplan,nodes}` + `cmd/orun` (CLI) |
| Target branch | `claude/overview-epic-architecture-7d28im` (all repos); feature PRs to `main` incrementally |
| Builds on | **WO** (the doc-blob spine, `doc_ref`, `repo_facet`, the sanitizing renderer, the digest read endpoint), **CP** `saas-catalog-portal` (the service page whose Docs tab goes real), `18-state.md` (CAS plane + projection + the derived-never-authored invariant), migration `570` (projection reconciliation, inherited) |
| Decisions locked | (1) **`docs.pages`** on the shared docs struct is the one multi-doc surface — ordered `{path, key?, title?, role?}`, `overview` reserved, ≤ 24/entity, per-doc 256 KiB, 8 MiB/closure; (2) pages ride the **existing `blob` closure** — no object kind, no CHECK migration, no release ordering; (3) every attached doc records **`commit`** and is read **at the pinned commit** (or attachment is refused on a dirty path, logged) — provenance is true by construction; (4) derived kinds get docs via the **`catalog.entities` enrichment block** — *enrich, never create*; (5) the browse surface reads a new **`state.catalog_docs`** projection behind one single-context endpoint; the body read reuses the shipped digest endpoint with a widened authorization resolve; (6) the console **never authors or fabricates docs** — synthetic doc files are removed; computed content renders only as a visibly-badged derived card. |
| Gate | Human-independent. No third-party credentials, no GitHub App, no new external dependency — entirely within the CLI-push → state-projection → console-render spine. |

## Thesis

An engineering org's documentation already lives in its repos, next to the code
it describes. Every platform that tried to fix docs by building a second home
for them (wikis, CMSes) created drift; every platform that renders straight
from git at view time coupled itself to a provider. Orun's position is already
the right one — **docs are catalog content**: declared in intent, pinned to the
commit, content-addressed, synced by set-difference, rendered by digest. WO
built that position; this epic makes it the *product*:

1. **Declare** — any entity points at its documents in the manifest it already
   owns (`docs.overview` + `docs.pages`); domains and systems get the same
   power via enrichment.
2. **Carry** — `orun plan` walks the bytes into the snapshot closure it already
   pushes; unchanged docs never re-upload.
3. **Browse** — orun cloud projects an org-wide doc index and renders a Docs
   hub, a reader, and real entity Docs tabs — sanitized, provenance-lined,
   drift-free.

The differentiator is unchanged from WO, now at full width: a PR that edits
`docs/architecture.md` updates the platform's rendering of that architecture —
no CMS, no sync job, no provider API, no second source of truth.

## How it maps to the model

| Concept | Internal reality | Source |
|---------|------------------|--------|
| Doc set | `docs.pages` + reserved `overview` on the shared docs struct | authored in the repo (`model.md §2`) |
| Doc identity | `(entity_ref, doc_key)`; content = `digest` | stable reader URLs, content-addressed bodies |
| Derived-kind docs | `catalog.entities` enrichment (`domain/*`, `system/*`, …) | `intent.yaml` (`model.md §3`) |
| Org doc index | `state.catalog_docs` (derived, per-scope, swept) | projector (`model.md §4`) |
| Docs hub / reader / entity tab | console reads index + blob-by-digest | read-edge assembly (`model.md §5`) |
| Provenance | `commit` per doc, pinned-commit read | `model.md §2b/§2d` |

## Read order

1. `README.md` (this file) — status + thesis + milestones + scope.
2. [`../saas-workspace-overview/review-2026-07-05.md`](../saas-workspace-overview/review-2026-07-05.md)
   — the post-ship review that charters this epic (findings F1–F8).
3. `model.md` — **the normative shared model**: intent surface, wire shape,
   enrichment, projection, read surface, link resolution.
4. `design.md` — the console surfaces: Docs hub IA, reader, entity Docs tab,
   empty states, the honest derived card.
5. `implementation-plan.md` — CD0–CD7 in three phases, split by repo, each with
   "done when".
6. `risks-and-open-questions.md` — what is genuinely open.

## Milestones at a glance

| ID | Phase | Milestone | Repo | Status |
|----|-------|-----------|------|--------|
| CD0 | — | Design + decision lock (this epic + the `orun` mirror + WO review) | all | 🔵 In review |
| CD1 | **1** | **CLI: the doc set** — `docs.pages` on the shared struct; walk **every** emitted entity's docs through `PendingDocs` (not just `Repo`); `commit` provenance + pinned-commit read / dirty-path refusal (closes WO F1/F3/F4); caps + logged truncation (closes WO Q4); `orun catalog docs <entity>` lists the set | `orun` | ⚪ Planned |
| CD2 | 1 | **CLI: enrichment** — `catalog.entities` block; merge metadata + docs onto derived `System`/`Domain` (+ `Group`/`Environment`); *enrich-never-create* validation (closes WO F6) | `orun` | ⚪ Planned |
| CD3 | **2** | **Platform: the doc index** — migration `state.catalog_docs`; projector emits doc rows in the same pass as entities; widen `findCatalogDocProject` to page digests; contracts + SDK + `GET …/catalog/docs` | `orun-cloud` | ⚪ Planned |
| CD4 | 2 | **Entity Docs tab goes real** — the service page reads the entity's doc set; fabricated `README.md`/`ARCHITECTURE.md`/… removed; computed facts survive only as a badged **derived card**; empty-state nudge with a copy-paste `docs.pages` snippet (closes WO F2) | `orun-cloud` | ⚪ Planned |
| CD5 | 2 | **The Docs hub** — `/orgs/{slug}/docs` (browse: kind/role/search) + `/orgs/{slug}/docs/{entityKey}/{docKey}` (reader: sanitized render, ToC, provenance + view-source, sibling rail); **Docs** nav item; Workspace Overview right-rail docs card (ships WO design §3's promised card, against real data) | `orun-cloud` | ⚪ Planned |
| CD6 | 3 | **Cross-doc links** — sibling-link rewriting within the pinned doc set; staleness polish ("N commits behind" when push events supply the tip) | `orun-cloud` | ⚪ Planned |
| CD7 | 3 (later) | **Deferred** — body full-text search (tsvector projection), doc-coverage as a scorecard signal (SC5), `Product` docs (rides WO6) | both | ⚪ Deferred |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The `docs.pages` doc set on every kind; per-doc `commit` provenance + pinned-commit read; the `catalog.entities` enrichment block (metadata + docs on derived kinds); `state.catalog_docs` + one list endpoint; the Docs hub, reader, real entity Docs tab, Overview docs card; sibling-link resolution; size caps with logged truncation; removal of synthesized doc files | **Any doc authoring/editing in the console** (no CMS, no override — ever); **any git-provider coupling at render time**; a new object kind; asset/image blobs (docs render text; images stay non-auto-loaded — Q4); body full-text search (CD7); folding `techdocs`/`runbooks`/`adrs` into pages (Q2); `Product` and multi-product docs (WO6/CD7); the Docusaurus product-docs site (`apps/web-docs` — a different system for a different audience; see design glossary) |

## Relationship to existing work

- **`saas-workspace-overview` (WO)** — the parent. Built the spine (doc blobs,
  `doc_ref`, `repo_facet`, digest endpoint, renderer); its post-ship review is
  this epic's charter. The Overview hero is untouched; its right rail finally
  gets the docs card WO's design promised.
- **`saas-catalog-portal` (CP)** — owns the service page whose Docs tab CD4
  makes real; the hub reuses CP's list/filter idioms and kind styling
  (`lib/catalog-kind.ts`).
- **`saas-service-catalog` (SC)** — the portal architecture parent; doc
  coverage becomes an SC5 scorecard input in CD7; the SC7 scaffolder's golden
  paths should scaffold `docs.pages` from day one.
- **`18-state.md` / `saas-orun-platform` (OP)** — the CAS plane, projection,
  and the *derived-never-authored* invariant this epic re-affirms (and, via
  F2's fix, restores).
- **`saas-mcp-server` (MCP)** — the doc index is an obvious future read tool
  ("fetch the runbook for service X"); CD keeps the surface SDK-shaped so MCP
  inherits it for free.
- **`sourceplane/ogpic`** — reference adopter: carries the worked example
  (`specs/epics/catalog-docs-adoption/` there) and pre-authored doc files,
  adopting `docs.pages` the first orun release after CD1.
