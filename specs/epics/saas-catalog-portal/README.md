# Epic: saas-catalog-portal

**Make the org catalog a world-class internal developer portal surface that
matches the `Service Catalog` design pixel-for-pixel.** This epic is the
design-driven *implementation* of the catalog console experience: the rich,
dark, IDP-class catalog index with metric tiles, Table / Board / dependency-Map
views, live filtering and grouping, and a deep entity detail drawer carrying
production-readiness scorecards, operational stats, ownership & on-call, and
the dependency neighborhood.

It is the visible front end of [`saas-service-catalog/`](../saas-service-catalog/)
(cluster **SC**) — that epic owns the architecture, the read-model invariant,
the contracts/overlays and the backend seams; this epic owns *shipping the
designed experience on top of them* and pulling the supporting data through.

## Status

| Field | Value |
|-------|-------|
| Status | **In progress** — CP0 (view-model + scorecards) → CP1 (index) → CP2 (board/map) → CP3 (drawer) → CP4 (data wiring) merged incrementally |
| Cluster | **CP** (catalog portal — the design-faithful console surface) |
| Owner(s) | `apps/web-console-next` (primary) · `packages/contracts` + `packages/sdk` (additive enrichment fields, scorecard/insights reads) · `apps/state-worker` (projection enrichment, scorecard compute) |
| Target branch | `claude/orun-cloud-catalog-2ailwz` (PRs merged incrementally) |
| Design source | [`design/Service_Catalog.dc.html`](./design/Service_Catalog.dc.html) — the vendored, version-controlled visual contract (a Claude Design `.dc.html` component; `design/support.js` is its runtime, reference only). Every CP milestone is verified against it. |
| Builds on | [`saas-service-catalog/`](../saas-service-catalog/) (SC0–SC8 architecture, the read-model invariant, the overlay/scorecard model), the shipped org-catalog browser (`apps/web-console-next/src/components/catalog/*`, `lib/catalog-*.ts`), `components/18-state.md` (the `catalog_entities` read-model + `OrgCatalogEntity` contract), and the U-track design system (`components/ui/*`, the dark amber theme that already mirrors the design's accent `#f59e0b`) |
| Pairs with | [`orun/specs/orun-catalog-portal/`](../../../../orun/specs/orun-catalog-portal/) (cluster **CPF**) — the git-authored snapshot fields the design needs (description · system · language/tags), carried through `orun catalog push`. One enrichment, two repos. |

## The read-model invariant (inherited, non-negotiable)

This epic changes *how the catalog looks and what computed/operational signals
sit beside it* — never *how catalog content is authored*. Per
`components/18-state.md` and `saas-service-catalog/design.md §1`, the catalog
read-model is **derived from git, never authored in the console**. Every field
the design surfaces falls into exactly one sanctioned shape:

| Design field | Source shape | Where it comes from |
|---|---|---|
| name · kind · ref · lifecycle · relations (deps / used-by) | **Git-derived** (exists today) | `OrgCatalogEntity` |
| description · system · language | **Git-authored snapshot data** (new) | `orun-catalog-portal` enriches `orun catalog push`; surfaced as additive optional fields on `OrgCatalogEntity` |
| owner / team · on-call | **Git-derived owner** + **operational-annotations overlay** | `owner` today; on-call from the SC6 annotations overlay (operational, explicitly *not* catalog content) |
| readiness score · tier · checks · insights · "needs attention" | **Computed overlay** | pure scorecard engine over snapshot signals (CP0); SC5 promotes to a backend projection |
| health · SLO · incidents · deploys/wk · last-deploy | **Runtime signals** | derived best-effort from the runs/deploy plane where present; the design's own logic already degrades every one of these gracefully (`hasOps=false`, managed health, `dh==null`, `noScore`) |

No console write authors a catalog row. The scorecard is computed; on-call is a
separated operational overlay; the scaffolder (out of scope here) writes git.

## Thesis

The catalog is the highest-leverage surface in an internal developer platform,
and the platform already has the hard part — a provenance-correct, git-derived
component graph merged across an org's projects. What was missing is the
*experience*. The `Service Catalog` design is exactly that experience, drawn:
one quiet dark surface where an engineer answers "what exists, who owns it, what
depends on what, is it production-ready, and is it healthy" without leaving the
page. This epic ships that design on the real read-model, computing what is
computable and degrading honestly where a runtime signal has no source yet.

## Read order

1. `README.md` (this file) — status, the invariant table, milestones.
2. `design.md` — the design → component map, the view-model layer, the scorecard
   engine, the exact palette/tokens, the data-sourcing strategy, and the
   graceful-degradation rules.
3. `implementation-plan.md` — CP0–CP4, each with "done when".
4. `design/Service_Catalog.dc.html` — the pixel-level visual contract.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| CP0 | **Catalog view-model + scorecard engine** — a pure, unit-tested layer mapping `OrgCatalogEntity[]` (+ optional enrichment + runtime signals) into the design's service / row / card / node / drawer shapes; computes readiness checks → score → tier, "needs attention", metric rollups. Additive optional contract/SDK fields. | 🚧 |
| CP1 | **Index surface** — header (eyebrow · title · Import / Register actions), the four metric tiles (Services · Ownership · Production-ready · Needs-attention toggle), the toolbar (search · kind / lifecycle / health / group selects · Table/Board/Map tabs), active-filter chips, incident banner, and the sortable + groupable **Table** view. Matches the design. | 🗓️ |
| CP2 | **Board + Map views** — the Kanban board (by lifecycle + infrastructure) and the system-columned dependency **Map** (SVG edges + positioned nodes), both wired to the same filter state. | 🗓️ |
| CP3 | **Entity detail drawer** — the overlay drawer: identity, ops stats (SLO · incidents · deploys), the production-readiness scorecard (progress ring + checks), ownership + on-call, dependency neighborhood (depends-on / used-by), footer quick links. | 🗓️ |
| CP4 | **Data wiring** — surface the git-authored enrichment (description · system · language) end to end; compute the scorecard projection + deploy-recency join in `apps/state-worker`; expose `getCatalogInsights` / `getEntityScorecard` per `saas-service-catalog/design.md §4`. | 🗓️ |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The catalog **page** matching the design: header, metric tiles, toolbar, chips, incident banner, Table / Board / Map views, the entity detail drawer, and the view-model + scorecard engine that feeds them; additive contract/SDK enrichment fields; the supporting `state-worker` projection/scorecard compute (CP4) | The app **shell** (sidebar / topbar / org-switcher — owned by `saas-console-ux`; the design's chrome is reference only); authoring catalog content in the console (forbidden by `18-state.md`); the golden-path scaffolder and on-call *authoring* UX (owned by `saas-service-catalog` SC6/SC7); incident management / paging delivery; real APM/SLO ingestion (a monitoring-integration concern — surfaced when a source exists, degraded until then) |

## Relationship to existing work

- **`saas-service-catalog` (SC)** is the parent architecture. This epic is its
  design-faithful UI realization; it consumes SC's contracts/overlays and, in
  CP4, lands the SC4/SC5 computed surfaces (`getCatalogInsights`,
  `getEntityScorecard`) the design needs. Where the two overlap, SC's design.md
  is normative on *architecture*; this epic's `design.md` is normative on
  *visual fidelity*.
- **`saas-console-ux` (U)** owns the shell and the design system. This epic uses
  its tokens and primitives and stays inside the catalog route.
- **`orun-catalog-portal` (CPF)** is the paired client-side enrichment: the
  git-authored `description` / `system` / `language` fields the design renders,
  carried through `orun catalog push`. Cross-repo, one enrichment.
