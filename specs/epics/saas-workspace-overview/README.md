# Epic: saas-workspace-overview

**Give every Workspace a front door.** Today `/orgs/{slug}` redirects straight to
Git Repos — a Workspace has no home, no answer to *"what is this, is it healthy,
what do I do next?"* This epic adds an **Overview** surface as the Workspace
landing: a product-identity band, a live signal row, and a repo-sourced product
narrative, composed almost entirely from data the platform already has.

The defining idea is **"the repo is the homepage."** Orun's thesis is *intent as
code; the repo is the source of truth.* The Overview embodies that — the product
description and narrative are **not** retyped into a console textbox; they are
**resolved from the connected repo** (`intent.yaml` metadata + a conventional
`overview.md`/README), the same way component intent lives beside its code. The
console *renders* the truth that is committed and reviewed; it never becomes a
second source of it. A PR to your docs updates your dashboard.

## Status

| Field | Value |
|-------|-------|
| Status | **Proposed** — design draft for review; no code landed |
| Cluster | **WO** (workspace overview — presentation layer over **WS** `saas-workspaces`, **CP** `saas-catalog-portal`, and the runs/activity feed) |
| Owner(s) | `apps/web-console-next` (UI) · `packages/contracts`/`sdk` (overview resolution) · the catalog-sync path (`orun plan` → orun-cloud) |
| Target branch | `claude/orun-workspace-overview-design-qonyiv` (design); feature PRs to `main` incrementally |
| Builds on | `saas-workspaces` (the Account/Workspace vocabulary the page is titled with), `saas-catalog-portal` (the `MetricTiles` rollup + `CatalogService` health/maturity model reused for the signal row), the org **Activities** runs feed (`components/activity/*`), `saas-integration-tenancy` (GitHub connection status), `saas-workspace-id` (durable `ws_` id) |
| Decisions locked | (1) The Overview **is** the Workspace landing — `/orgs/{slug}` renders it instead of redirecting to `/projects`; (2) **repo-sourced as a content-addressed state object, not a console CMS** — `orun plan` pushes each referenced `docs.overview` into the object **closure** as its own `doc` object (set-difference sync); the entity's `doc_ref` is `{path, ref, sha, digest}` and orun-cloud renders the body from R2 **by digest** — provider-agnostic (any git remote, no App), point-in-time-consistent with the catalog head, self-host-portable. Fetch-live via the GitHub App is an **optional drift/"latest-on-branch" overlay only** (see `kinds-and-docs-model.md`); (3) repo/product identity are **first-class declared entity kinds** (`Repo`, `Product`) emitted from `intent.yaml` over the existing snapshot path — `kind` is free-text TEXT server-side, **no enum migration**; a `docs.overview` pointer is added to the **shared** docs struct so it spans every kind; (4) **reuse, don't reinvent** — signal row reuses the catalog rollup, run-rows, the GitHub **token-broker**, and `repo_links`; (5) markdown rendered through a **sanitizing** pipeline (untrusted repo content). |
| Gate | Human-independent for WO1–WO5. WO6 (live git fetch) depends on `saas-integration-tenancy` repo-read scope. |

## Thesis

A Workspace already *has* everything an overview needs — a catalog (synced from
`orun plan`), a runs/activity history, connected repos, an integration
connection, and a name/description declared in the repo's `intent.yaml`. What it
lacks is a **place that composes them into one answer.** New operators land in a
list of repos and have to reconstruct context by clicking around; there is no
narrative layer and no at-a-glance health.

The Overview answers three questions on one screen:

1. **What is this?** — product identity + narrative, resolved from the repo.
2. **Is it healthy?** — catalog health, recent run activity, integration status.
3. **What do I do next?** — jump-off points to Catalog, Activities, Git Repos.

The differentiator is the narrative source. Most dashboards make you re-enter a
product description into a settings form — a second source of truth that drifts.
Here, because a Workspace's product is defined by a repo whose `intent.yaml`
declares `execution.state.org = <this workspace>`, the Overview reads that repo's
own `metadata.name`/`description`/`namespace` and a conventional `overview.md`.
The homepage is generated from the same artifact that is already reviewed in PRs.

## How it maps to the model

| Concept | Internal reality | Source for the Overview |
|---------|------------------|--------------------------|
| Workspace | an `organizations` row (`saas-workspaces`) | the scope the page is rendered for |
| Product identity | `intent.yaml` `metadata.{name,description,namespace}` of the primary connected repo | structured fields, synced at plan time |
| Narrative / "what is this" | `overview.md` → `docs/overview.md` → `README.md` in that repo | markdown, synced at plan time, rendered sanitized |
| Components summary | the catalog (`saas-catalog-portal`) | reuse `rollup` + `MetricTiles` |
| Activity summary | the runs feed | reuse `run-rows` + `run-status-icon` |
| Repos / Integrations | projects + GitHub connection | reuse existing list endpoints |

## Read order

1. `README.md` (this file) — status, thesis, milestones-at-a-glance.
2. `design.md` — IA, the markdown-sourcing model, the section-by-section layout,
   empty states, the rendering/security pipeline, and what deliberately does not
   change.
3. `wiring.md` — the verified `orun → orun-cloud` push flow, the multi-repo
   merge model, and how identity/pointers ride the catalog snapshot (its §3 is
   partly superseded by the doc below — see the note there).
4. `kinds-and-docs-model.md` — **the current model**: the `docs.overview`
   convention across all kinds, the new declared `Repo`/`Product` kinds, the
   `state.repo_facet` repo top-layer, and **fetch-live markdown via the GitHub
   integration** (state stores the pointer, not the body).
5. `design/overview-mockup.html` — a static, token-faithful mockup of the page
   (mirrors the `saas-catalog-portal/design/*.html` convention).

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| WO1 | Design + decision lock (this epic): landing-replaces-redirect, repo-sourced narrative, reuse rollup/activity, sanitized rendering | 🔵 Proposed |
| WO2a | `orun`: add `docs.overview` to the shared docs struct; add declared `repo` + `products` blocks; **walk each `docs.overview` into the object closure as a `doc` object**, record `doc_ref={path,ref,sha,digest}`; emit `Repo`/`Product` entities (kind constants + `allEntityKinds` + specs + summary counts) | ⚪ Not started |
| WO2b | orun-cloud: add `doc` to the `state.objects.kind` CHECK; projector (`catalog-projection.ts`) projects `Repo`→`state.repo_facet`, `Product`→`org_catalog_entities`, `doc_ref` (digest pointer) onto entities; read-doc-by-digest path for the console; add `Repo`/`Product` to `lib/catalog-kind.ts`; add `primary_project_id` (+ optional `override_overview`) on the org; `GET /v1/organizations/{orgId}/overview` resolver | ⚪ Not started |
| WO2c | *(optional)* integrations-worker: `getRepositoryFileContents` in `github-app.ts` + a small `repo/doc/head` handler over the **token-broker** (`contents:read`, per-request scoped) for the live drift/"latest-on-branch" badge; `scm.push` flips the drift flag (no persistent content cache — the CAS `doc` object is the base render) | ⚪ Not started |
| WO3 | Route + nav: `/orgs/{slug}` renders Overview (drop the `/projects` redirect); add the "Overview" sidebar item (top of the Workspace section); breadcrumbs | ⚪ Not started |
| WO4 | UI — identity band + signal row (reuse catalog `rollup`/`MetricTiles`) + right-rail summary cards (reuse `run-rows`, repo + integration lists) + empty/first-run states | ⚪ Not started |
| WO5 | Markdown pipeline: `react-markdown` + `remark-gfm` + `rehype-sanitize`; "Synced from `<repo>@<sha>`" provenance + "Edit on GitHub" + pinned docs | ⚪ Not started |
| WO6 | (Optional) live git-fetch fallback via `saas-integration-tenancy` repo read; console-authored override editor for not-yet-connected Workspaces | ⚪ Not started |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The Overview page as the Workspace landing; resolving product identity + narrative from the connected repo; reusing the catalog rollup and activity feed for live summaries; the markdown rendering/sanitizing pipeline; empty/first-run states; the override escape hatch | A new entity or table (the Overview is a *projection*, not a model — same relabel-not-remodel discipline as `saas-workspaces`); a console WYSIWYG CMS for the narrative; renaming `project`/`environment`; the catalog-sync mechanism itself (`saas-catalog-portal`); the GitHub integration mechanism (`saas-integration-tenancy`) |

## Relationship to existing work

- **`saas-workspaces` (WS)** — supplies the Account/Workspace vocabulary the page
  is titled and scoped with. The Overview is the most prominent place that
  vocabulary appears.
- **`saas-catalog-portal` (CP)** — the signal row reuses CP's `rollup`,
  `MetricTiles`, and `CatalogService` health/maturity model verbatim; the
  "Components at a glance" card links into the catalog.
- **Activities / runs** — the "Recent activity" card reuses `run-rows` and
  `run-status-icon`; "View all" links to the org Activities feed.
- **`saas-integration-tenancy` (IT)** — the "Integrations" card reflects the
  Account's GitHub connection; WO6's optional live git fetch depends on its
  repo-read scope.
- **`saas-workspace-id` (WID)** — the durable `ws_` id is the stable key the
  override record and synced overview hang off.
