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

> **Revised 2026-07-01** to adopt `architecture-review.md`. The thesis is
> unchanged; the plan is now **phased** (ship the landing from orun-cloud alone,
> then the cross-repo narrative), the **`Repo` ref is the repo-local
> `<namespace>/<repo>/<name>` key** (no cloud project id at resolve time; §2c),
> **`Product` is deferred** behind the
> single-per-repo `Repo` kind, **docs ride the existing `blob` closure (no new
> object kind)**, there is **no console-authored `override_overview`**, and there
> is **no bespoke `/overview` endpoint** (the page is assembled at the read edge).
> See `architecture-review.md` for the rationale.

## Status

| Field | Value |
|-------|-------|
| Status | **✅ Shipped (WO1–WO5)** — the Workspace Overview is live: design (#245, #256), the landing (#272), the CLI half in `orun` (WO3a/b/c #434/#435/#436), projection → `state.repo_facet` + `doc_ref` (#276), console repo-facet reads + doc-by-digest (#277), narrative render + facet surfaces (#278), and Overview as the default landing + mobile tabs (#312). **WO6** (`Product` + explicit primary) remains **deferred** by design. |
| Cluster | **WO** (workspace overview — presentation + catalog-model layer over **WS** `saas-workspaces`, **CP** `saas-catalog-portal`, **OP** state/`18-state.md`, and the runs feed) |
| Repos | `sourceplane/orun-cloud` (platform, TS) · `sourceplane/orun` (CLI/engine, Go) |
| Owner(s) | `apps/state-worker` + `apps/web-console-next` + `packages/{contracts,db}` (platform) · `internal/catalogmodel` + `internal/model` + `cmd/orun` (CLI) |
| Target branch | `claude/orun-workspace-overview-design-qonyiv` (both repos); feature PRs to `main` incrementally |
| Builds on | `saas-workspaces` (Account/Workspace vocabulary), `saas-catalog-portal` (`MetricTiles` rollup + `CatalogService` model reused for the signal row), `specs/components/18-state.md` (the CAS object plane + catalog heads + `org_catalog_entities` projection this extends), the org **Activities** runs feed (`components/activity/*`), `saas-workspace-id` (durable `ws_` id) |
| Decisions locked | (1) The Overview **is** the Workspace landing — `/orgs/{slug}` renders it instead of redirecting to `/projects`, and it **ships first from orun-cloud alone** (signal row + repos + empty states) before the cross-repo narrative chain; (2) **repo-authored docs travel as content-addressed blobs** in the catalog snapshot closure (set-difference sync), read **at the pinned commit** and rendered from R2 **by digest** — **no git-provider coupling at render time**, provider-agnostic (any git remote), self-host-portable, point-in-time-consistent with the catalog head; docs ride the **existing `blob` kind** (no new object kind, no CHECK migration); (3) repo identity is a **first-class declared kind `Repo`** (one per `intent.yaml`, ref minted from the **durable project id**) emitted over the existing snapshot path — `kind` is free-text TEXT server-side, so **no kind-enum migration**; a `docs.overview` pointer is added to the **shared** docs struct so it spans every kind; **`Product` and multi-product are deferred** (WO6) until multi-repo workspaces are real; (4) **reuse, don't reinvent** — the signal row reuses the catalog rollup and run-rows; (5) markdown rendered through a **sanitizing** pipeline (untrusted repo content); (6) **the console never authors catalog content** — there is **no `override_overview`** and **no `/overview` endpoint** (the page is assembled at the read edge; a not-yet-linked workspace shows the empty-state CTA). |
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
| Product identity (v1) | `intent.yaml metadata.{name,description,namespace}` + the **primary `Repo`** | structured fields projected from the snapshot (a first-class `Product` kind is deferred to WO6) |
| Repo identity | a declared `Repo` (one per `intent.yaml`, keyed by project) | `state.repo_facet`, drives the Git Repos list + the Overview identity |
| Narrative / "what is this" | `docs.overview` on a `Repo`/component (a `Product` in WO6) | a content-addressed blob in the snapshot, rendered by digest |
| Components summary | the catalog (`saas-catalog-portal`) | reuse `rollup` + `MetricTiles` |
| Activity summary | the runs feed | reuse `run-rows` + `run-status-icon` |

## Read order

1. `README.md` (this file) — status + thesis + milestones + scope.
2. `design.md` — the Overview page: IA, section-by-section layout, empty states,
   the sanitizing render pipeline.
3. `model.md` — **the normative shared model**: the `docs.overview` convention
   across all kinds, the declared `Repo` kind (ref = repo-local `<namespace>/<repo>/<name>`),
   the `doc`-object state model, `state.repo_facet`, the verified `orun →
   orun-cloud` push flow, and the deferred `Product` (§7). (The `orun` repo's copy
   references this.)
4. `implementation-plan.md` — WO1–WO6 in three phases, each with "done when",
   split by repo.
5. `risks-and-open-questions.md` — the decisions still open and the ones locked.
6. `architecture-review.md` — a lead-architect pass grounded against the code as
   it stands (2026-07-01): code-reality corrections, a simplify/scope pass, and a
   sequencing change that ships the landing before the cross-repo CLI chain. Read
   it before WO2 code lands.
7. `design/overview-mockup.html` — a token-faithful static mockup (mirrors the
   `saas-catalog-portal/design/*.html` convention).

## Milestones at a glance

| ID | Phase | Milestone | Repo | Status |
|----|-------|-----------|------|--------|
| WO1 | — | Design + decision lock (this epic), cross-repo | both | ✅ Landed |
| WO2 | **1** | **The landing** — `/orgs/{slug}` renders Overview (drop the `/projects` redirect); Overview nav item + breadcrumbs; identity band; signal row (reuse `rollup`/`MetricTiles` + a **composed** Activity tile); right-rail (repos from `projects`+`workspace_links`, recent activity from runs); empty/first-run states. **No CLI, no new object kind, no migration.** | `orun-cloud` | ✅ Merged (#272) |
| WO3 | 2 | **CLI** — `docs.overview` on the shared docs struct; declared `repo` block + `Repo` kind (**ref = repo-local `<namespace>/<repo>/<name>`**); walk each `docs.overview` into the closure as a content-addressed **blob** (`doc_ref={path,sha,digest}`); emit `Repo` entities. (Shipped as WO3a #434 + WO3c #435 + WO3b #436.) | `orun` | ✅ Merged |
| WO4 | 2 | **Projection** — create `state.repo_facet` (keyed by project); `doc_ref` on `org_catalog_entities`; projector projects `Repo`→`repo_facet` + `doc_ref`; add `Repo` to `lib/catalog-kind.ts`. **No object-kind migration** (docs ride the existing `blob` kind), **no `/overview` endpoint, no org columns.** | `orun-cloud` | ✅ Merged (#276; migration `460_state_repo_facet`) |
| WO5 | 2 | **Narrative render + facet surfaces** — resolve primary repo identity (client-side, no endpoint); narrative band (sanitized markdown by digest) + provenance + "N commits behind" staleness; Git Repos list + repo header read `state.repo_facet` | `orun-cloud` | ✅ Merged (WO5a #277 reads + doc-by-digest · WO5b #278 render) |
| WO6 | 3 (later) | **`Product` + explicit primary** — `products` block + `Product` kind (merges across repos); `primary_project_id` on the org; product cards. Deferred until multi-product/multi-repo workspaces are real. | both | ⚪ Deferred |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The Overview as the Workspace landing (shipped first, orun-cloud-only); the declared `Repo` kind + `docs.overview` across all kinds; docs as content-addressed blobs read at the pinned commit; `state.repo_facet`; reusing the catalog rollup and activity feed; the sanitizing render pipeline; empty/first-run states | **Any git-provider coupling at render time** (no GitHub App, no live fetch, no token broker); a console WYSIWYG CMS or **any console-authored overview** (no `override_overview`); a bespoke **`/overview` endpoint** (assembled at the read edge); the **`Product` kind + multi-product** (deferred to WO6); **any new object kind** (docs ride the existing `blob` kind) or entity/table beyond `repo_facet` + a `doc_ref` column; renaming `project`/`environment`; the catalog-sync mechanism itself (`saas-catalog-portal`) |

## Relationship to existing work

- **`saas-workspaces` (WS)** — supplies the Account/Workspace vocabulary the page
  is titled and scoped with; the Overview is its most prominent surface.
- **`saas-catalog-portal` (CP)** — the signal row reuses CP's `rollup`,
  `MetricTiles`, and `CatalogService` model; "Components at a glance" links in.
- **`18-state.md` / `saas-orun-platform` (OP)** — the CAS object plane, catalog
  heads, and the `org_catalog_entities` projection this epic extends with a `Repo`
  projection + `state.repo_facet`; docs ride the existing `blob` closure, adding no
  object kind. Its *"console never authors catalog content"* invariant is why there
  is no `override_overview`.
- **Activities / runs** — "Recent activity" reuses `run-rows` + `run-status-icon`.
- **`saas-workspace-id` (WID)** — the durable `ws_`/project id is what the `Repo`
  entity ref is minted from (the stable join key, in place of an un-normalized
  remote string).
- **`saas-unified-onboarding` (UO)** — locks "repo" as the user-facing noun for a
  project; the `Repo` kind is that project's self-description, and the WO2 empty
  state is the post-onboarding "link a repo" destination.
