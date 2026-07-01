# Epic: saas-workspace-overview

> **Cross-repo epic.** Mirrored in **`sourceplane/orun-cloud`**
> (`specs/epics/saas-workspace-overview/`) and **`sourceplane/orun`**
> (`specs/orun-workspace-overview/`). The normative shared model —
> the `intent.yaml` surface, the new catalog **kinds**, and the doc-object
> state model — is `model.md` here; the `orun` copy references it and owns the
> CLI half. Keep the ownership split in §"Milestones" in sync.

**Give every Workspace a front door.** Today `/orgs/{slug}` redirects straight to
Git Repos — a Workspace has no home, no answer to *"what is this, is it healthy,
what do I do next?"* This epic adds an **Overview** surface as the Workspace
landing: a product-identity band, a live signal row, and a repo-authored product
narrative, composed almost entirely from data the platform already has.

The defining idea is **"the repo is the homepage."** Orun's thesis is *intent as
code; the repo is the source of truth.* The Overview embodies that — the product
description and narrative are **not** retyped into a console textbox; they are
**authored in the repo** (`intent.yaml` metadata + a conventional `overview.md`)
and carried into the platform the exact same way component intent already is: as
**content-addressed objects in the catalog snapshot**, pinned to the commit the
catalog head was advanced at. The console *renders* what git produced; it never
becomes a second source of it, and it never reaches back into a git provider at
render time.

## Status

| Field | Value |
|-------|-------|
| Status | **Proposed** — design complete, cross-repo; no code landed |
| Cluster | **WO** (workspace overview — presentation + catalog-model layer over **WS** `saas-workspaces`, **CP** `saas-catalog-portal`, **OP** state/`18-state.md`, and the runs feed) |
| Repos | `sourceplane/orun-cloud` (platform, TS) · `sourceplane/orun` (CLI/engine, Go) |
| Owner(s) | `apps/state-worker` + `apps/web-console-next` + `packages/{contracts,db}` (platform) · `internal/catalogmodel` + `internal/model` + `cmd/orun` (CLI) |
| Target branch | `claude/orun-workspace-overview-design-qonyiv` (both repos); feature PRs to `main` incrementally |
| Builds on | `saas-workspaces` (Account/Workspace vocabulary), `saas-catalog-portal` (`MetricTiles` rollup + `CatalogService` model reused for the signal row), `specs/components/18-state.md` (the CAS object plane + catalog heads + `org_catalog_entities` projection this extends), the org **Activities** runs feed (`components/activity/*`), `saas-workspace-id` (durable `ws_` id) |
| Decisions locked | (1) The Overview **is** the Workspace landing — `/orgs/{slug}` renders it instead of redirecting to `/projects`; (2) **repo-authored docs travel as content-addressed `doc` objects** in the catalog snapshot closure (set-difference sync), rendered from R2 **by digest** — **no git-provider coupling at render time**, provider-agnostic (any git remote), self-host-portable, and point-in-time-consistent with the catalog head; (3) repo/product identity are **first-class declared entity kinds** (`Repo`, `Product`) emitted from `intent.yaml` over the existing snapshot path — `kind` is free-text TEXT server-side, so **no kind-enum migration**; a `docs.overview` pointer is added to the **shared** docs struct so it spans every kind; (4) **reuse, don't reinvent** — the signal row reuses the catalog rollup and run-rows; (5) markdown rendered through a **sanitizing** pipeline (untrusted repo content). |
| Gate | Human-independent. No third-party credentials, no GitHub App, no new external dependency — the feature is entirely within the existing CLI-push → state-projection → console-render spine. |

## Thesis

A Workspace already *has* everything an overview needs — a catalog (synced from
`orun plan`), a runs/activity history, connected repos, and a name/description
declared in the repo's `intent.yaml`. What it lacks is a **place that composes
them into one answer.** New operators land in a list of repos and reconstruct
context by clicking around; there is no narrative layer and no at-a-glance health.

The Overview answers three questions on one screen:

1. **What is this?** — product identity + narrative, authored in the repo.
2. **Is it healthy?** — catalog health + recent run activity.
3. **What do I do next?** — jump-off points to Catalog, Activities, Git Repos.

The differentiator is that the narrative is git-authored and travels as part of
the catalog, so a PR to `overview.md` updates the homepage — with no console CMS,
no drift, and no live provider call.

## How it maps to the model

| Concept | Internal reality | Source for the Overview |
|---------|------------------|--------------------------|
| Workspace | an `organizations` row (`saas-workspaces`) | the scope the page renders for |
| Product identity | `intent.yaml metadata.{name,description,namespace}` + a declared `Product` | structured fields projected from the snapshot |
| Repo identity | a declared `Repo` (one per `intent.yaml`) | `state.repo_facet`, drives the Git Repos list |
| Narrative / "what is this" | `docs.overview` on a `Repo`/`Product`/component | a content-addressed `doc` object in the snapshot, rendered by digest |
| Components summary | the catalog (`saas-catalog-portal`) | reuse `rollup` + `MetricTiles` |
| Activity summary | the runs feed | reuse `run-rows` + `run-status-icon` |

## Read order

1. `README.md` (this file) — status + thesis + milestones + scope.
2. `design.md` — the Overview page: IA, section-by-section layout, empty states,
   the sanitizing render pipeline.
3. `model.md` — **the normative shared model**: the `docs.overview` convention
   across all kinds, the declared `Repo`/`Product` kinds, the `doc`-object state
   model, `state.repo_facet`, and the verified `orun → orun-cloud` push flow.
   (The `orun` repo's copy references this.)
4. `implementation-plan.md` — WO1–WO5, each with "done when", split by repo.
5. `risks-and-open-questions.md` — the decisions still open and the ones locked.
6. `architecture-review.md` — a lead-architect pass grounded against the code as
   it stands (2026-07-01): code-reality corrections, a simplify/scope pass, and a
   sequencing change that ships the landing before the cross-repo CLI chain. Read
   it before WO2 code lands.
7. `design/overview-mockup.html` — a token-faithful static mockup (mirrors the
   `saas-catalog-portal/design/*.html` convention).

## Milestones at a glance

| ID | Milestone | Repo | Status |
|----|-----------|------|--------|
| WO1 | Design + decision lock (this epic), cross-repo | both | 🔵 Proposed |
| WO2a | `docs.overview` on the shared docs struct; declared `repo` + `products` blocks; walk each `docs.overview` into the object closure as a `doc` object (`doc_ref={path,ref,sha,digest}`); emit `Repo`/`Product` entities | `orun` | ⚪ Not started |
| WO2b | Add `doc` to the `state.objects.kind` CHECK; projector projects `Repo`→`state.repo_facet`, `Product`→`org_catalog_entities`, `doc_ref` onto entities; read-doc-by-digest for the console; add `Repo`/`Product` to `lib/catalog-kind.ts`; `primary_project_id` (+ optional `override_overview`) on the org; `GET /v1/organizations/{orgId}/overview` resolver | `orun-cloud` | ⚪ Not started |
| WO3 | Route + nav: `/orgs/{slug}` renders Overview (drop the `/projects` redirect); add the "Overview" sidebar item; breadcrumbs | `orun-cloud` | ⚪ Not started |
| WO4 | UI — identity band + signal row (reuse `rollup`/`MetricTiles`) + right-rail summary cards (reuse `run-rows`, repo list) + `Repo`/`Product` overview render (sanitized, by digest) + empty/first-run states | `orun-cloud` | ⚪ Not started |
| WO5 | Git Repos list reads `state.repo_facet` (description/owner/overview badge) | `orun-cloud` | ⚪ Not started |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The Overview as the Workspace landing; declared `Repo`/`Product` kinds + `docs.overview` across all kinds; docs as content-addressed `doc` objects in the snapshot; `state.repo_facet`; reusing the catalog rollup and activity feed; the sanitizing render pipeline; empty/first-run states | **Any git-provider coupling at render time** (no GitHub App, no live fetch, no token broker); a console WYSIWYG CMS; a new entity/table beyond `repo_facet` + a `doc_ref` column + the `doc` object kind; renaming `project`/`environment`; the catalog-sync mechanism itself (`saas-catalog-portal`) |

## Relationship to existing work

- **`saas-workspaces` (WS)** — supplies the Account/Workspace vocabulary the page
  is titled and scoped with; the Overview is its most prominent surface.
- **`saas-catalog-portal` (CP)** — the signal row reuses CP's `rollup`,
  `MetricTiles`, and `CatalogService` model; "Components at a glance" links in.
- **`18-state.md` / `saas-orun-platform` (OP)** — the CAS object plane, catalog
  heads, and the `org_catalog_entities` projection this epic extends with a `doc`
  object kind, a `Repo`/`Product` projection, and `state.repo_facet`.
- **Activities / runs** — "Recent activity" reuses `run-rows` + `run-status-icon`.
- **`saas-workspace-id` (WID)** — the durable `ws_` id keys the override record.
