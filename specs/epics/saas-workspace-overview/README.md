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
| Decisions locked | (1) The Overview **is** the Workspace landing — `/orgs/{slug}` renders it instead of redirecting to `/projects`; (2) **repo-sourced narrative, not a console CMS** — markdown is resolved from the connected repo, with a console-authored override as the only escape hatch for repos-not-yet-connected; (3) **reuse, don't reinvent** — the signal row reuses the catalog rollup and the activity run-rows verbatim; (4) markdown is rendered through a **sanitizing** pipeline (untrusted repo content). |
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
   merge model, and exactly how the Overview is fed (the snapshot `product`
   block, the `project_overview` projection, the `primary_project_id` pointer).
4. `design/overview-mockup.html` — a static, token-faithful mockup of the page
   (mirrors the `saas-catalog-portal/design/*.html` convention).

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| WO1 | Design + decision lock (this epic): landing-replaces-redirect, repo-sourced narrative, reuse rollup/activity, sanitized rendering | 🔵 Proposed |
| WO2 | Overview resolution (see `wiring.md`): add a `product` block to `orun`'s `CatalogSnapshot` (name/description/namespace/overviewMarkdown/docs); project it on `catalog.head.advanced` into a derived `state.project_overview` table; add `primary_project_id` + optional `override_overview` on the org; expose `GET /v1/organizations/{orgId}/overview` | ⚪ Not started |
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
