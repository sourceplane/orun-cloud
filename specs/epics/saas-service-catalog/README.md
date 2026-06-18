# Epic: saas-service-catalog

**Turn the org catalog from a filterable table into an internal developer
portal.** Today `/orgs/{org}/catalog` renders a merged, read-only component
graph as a table with an inline detail card. This epic evolves it into a
Backstage/Cortex/Port-class catalog: every entity is a deep-linkable page with a
contextual sidebar, a dependency graph, deployment provenance, change history,
computed **scorecards** and **insights**, **ownership & on-call**, and a
**golden-path scaffolder** — without ever breaking the platform invariant that
the catalog read-model is *derived from git, never authored in the console*.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — SC0 (drill-down foundation) is human-independent and PR-ready; SC5–SC7 carry product/data decisions (see `risks-and-open-questions.md`) |
| Cluster | **SC** (service catalog / internal developer portal — evolves OP's Catalog surface + the U-track console) |
| Owner(s) | `apps/web-console-next` (primary) + `apps/state-worker` (overlays/projections) + `packages/contracts`/`sdk`/`cli` + `packages/db` (overlay migrations) + `apps/integrations-worker` (scaffolder repo writes, SC7) |
| Target branch | `claude/hopeful-brown-07uw3l` (PRs merged incrementally) |
| Builds on | `components/18-state.md` (the `catalog_entities` read-model + heads), `epics/saas-orun-platform/` (OV7 org-catalog browser, shipped), `epics/saas-console-ux/` (U3 URL scope, U11 settings sub-panel mechanism, Cmd-K), `apps/web-console-next/src/components/shell/{nav-items,sidebar,settings-nav}.ts(x)` (the rail-swap pattern this epic reuses for the entity sidebar) |
| Decisions locked | (1) **Hybrid drill-down**: a quick-peek drawer (`?entity=`) plus a deep-linkable `/catalog/[entityKey]` route; the route is the home for rich content, the drawer keeps browsing fast. (2) **Contextual sidebar by generalization**, not a new mechanism — the entity rail reuses the same swap+slide the Settings panel already uses (`subPanel` flag + `sidebar.tsx`). (3) **v1 tabs**: Overview · Dependency graph · Deployments/envs · Activity. (4) **Differentiators committed**: scorecards/maturity, catalog insights, ownership & on-call, golden-path scaffolder. (5) **The read-model invariant is preserved** — every enrichment is either a *computed overlay* (insights, scorecards), *git-authored snapshot data* (intrinsic ownership), a *clearly-separated operational annotation store* (on-call contacts, explicitly **not** catalog content), or a *git-writing scaffolder* (golden paths produce repos/PRs; the catalog reflects the result through the normal push path). The console never authors a catalog row. |

## Thesis

The catalog is the single highest-leverage surface in an internal developer
platform: it is where an engineer answers "what services exist, who owns them,
what depends on what, are they healthy, and how do I make a new one correctly."
Backstage made that surface a category; Cortex and OpsLevel made *scorecards*
the reason teams pay; Port made the *graph* and self-service the differentiator.

This platform already has the hard part — a provenance-correct, git-derived
component graph merged across an org's projects (`catalog_entities`, OV7). What
it lacks is the **experience**: the catalog is a flat table whose detail is an
inline card with no URL of its own. You cannot link a teammate to a service, you
cannot see its dependency graph, you cannot tell if it is production-ready, and
you cannot stamp out a new one from a golden path.

The bet: keep the derived-from-git spine exactly as it is (it is the platform's
honesty guarantee), and build the portal experience *around* it as three
additive layers — drill-down navigation, computed overlays, and a git-writing
scaffolder. None of them author catalog content, so none of them compromise the
"renders what git produced, drift-free" promise in `components/18-state.md`.

## How it maps to the reference IDPs

| Backstage / Cortex / Port | Here |
|---|---|
| Catalog entity page (`/catalog/default/component/x`) | `/orgs/{org}/catalog/[entityKey]` — deep-linkable route with a contextual sidebar (SC0) |
| Entity "About" + relations cards | Overview tab (promotes today's inline `EntityDetail`) (SC0) |
| Relations graph / system view | Dependency graph tab + an org-level graph view toggle (SC1) |
| Deployment/CI cards on the entity | Deployments tab — provenance across environments, linked Runs (SC2) |
| Entity changelog | Activity tab — catalog-head history diffed via `headDigest` (SC3) |
| Catalog quality / coverage | Insights — computed overlay (missing owners, stale, unowned deps) (SC4) |
| Cortex/OpsLevel scorecards | Scorecards/maturity — computed overlay over snapshot + run signals (SC5) |
| Owner + Slack + on-call (`catalog-info.yaml`) | Intrinsic owner from the git snapshot + a separated operational-annotations overlay (SC6) |
| Backstage Software Templates / Port self-service | Golden-path scaffolder — writes a repo/PR via integrations, not the catalog (SC7) |

## Read order

1. `README.md` (this file) — status + thesis + milestones-at-a-glance + scope.
2. `design.md` — the read-model invariant, the three-layer enrichment model,
   routes/IA, the contextual-sidebar generalization, the URL key codec, the
   contract/SDK additions, the overlay schema, the scorecard engine, the
   ownership model, and the scaffolder seam.
3. `implementation-plan.md` — SC0–SC8, each with "done when".
4. `risks-and-open-questions.md` — the locked-vs-open decisions (ownership
   source, graph library, scorecard rule format, scaffolder placement, the
   write-path/invariant tension).

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| SC0 | Drill-down foundation: `/catalog/[entityKey]` route + URL key codec, contextual entity sidebar (generalized rail-swap), quick-peek drawer (`?entity=`) with Expand, Overview tab, `state.getOrgCatalogEntity` contract+SDK | 🗓️ Planned (human-independent) |
| SC1 | Dependency graph: interactive per-entity relations graph + org-level graph view toggle on the index | 🗓️ Planned |
| SC2 | Deployments/envs tab: provenance across environments, linked Runs, head digest per env | 🗓️ Planned |
| SC3 | Activity tab: catalog-head history + snapshot diff via `headDigest` | 🗓️ Planned |
| SC4 | Catalog insights (computed overlay): coverage/missing-owner/stale; index banner + insights surface | 🗓️ Planned |
| SC5 | Scorecards/maturity (computed overlay): rules engine over snapshot + run/deploy signals; Health tab + column; overlay projection + migration | 🗓️ Planned (decision: rule format) |
| SC6 | Ownership & on-call: intrinsic owner from enriched snapshot + separated operational-annotations overlay (team, Slack, escalation) | 🗓️ Planned (decision: ownership source) |
| SC7 | Golden-path scaffolder: template registry → git scaffolding via integrations; the first self-service write path (never authors catalog rows) | 🗓️ Planned (sub-epic candidate) |
| SC8 | Console-to-standard polish: saved views / "My services" default / group-by (system·domain·owner·kind) / health columns / Cmd-K "open service · find owner" | 🗓️ Planned (trails the data it surfaces) |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The catalog *experience*: entity routes + contextual sidebar + drawer; dependency graph; deployment/activity tabs; computed insights and scorecard overlays; intrinsic ownership surfacing + an operational-annotations overlay; the golden-path scaffolder seam; index polish (saved views, group-by, health columns, Cmd-K); contract/SDK/CLI additions for single-entity reads, overlays, and scaffolding | Authoring catalog content in the console (forbidden by `18-state.md` — the catalog stays git-derived); a second catalog model or store; replacing the OV7 projection (it is consumed as-is); CI/build execution (a product/runtime concern, P2); the GitHub App install/token machinery the scaffolder *uses* (owned by `saas-integrations`); incident management / paging delivery (we surface escalation targets, we do not page) |

## Relationship to existing work

- **OP / `saas-orun-platform` (OV7)**: shipped the org-catalog browser and the
  `catalog_entities` read-model this epic builds on. SC0–SC3 are pure
  experience layers over that projection; SC4–SC5 add *sibling* read-only
  projections/overlays in the `state` schema, never touching catalog content.
- **`components/18-state.md`**: the binding contract. "Catalog heads are the
  only mutable pointers… the read-model is derived, never authored." Every
  milestone here is designed to keep that true — the invariant is a feature
  (drift-free provenance), not a limitation to route around.
- **U / `saas-console-ux` (U11)**: the Settings sub-panel rail-swap
  (`subPanel` flag + the `inSettings` branch in `sidebar.tsx`) is the exact
  pattern SC0 generalizes into an entity sidebar — no new navigation primitive.
- **IG / `saas-integrations`**: SC7's scaffolder writes repos/PRs through the
  integrations token broker (IG4) — the scaffolder owns the *templates and the
  catalog story*, integrations owns *acting on GitHub*. SC7 should not start
  before IG4 (or must ship behind a dormant provider seam).
- **`saas-multi-org-billing`**: scorecards/scaffolder are the natural premium
  surfaces — gate via the materialized per-org entitlement seam
  (`feature.catalog_scorecards`, `feature.catalog_scaffolder`) and the U7
  upgrade UX, unchanged.
