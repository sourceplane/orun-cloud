# saas-service-catalog — Implementation Plan (SC0–SC8)

Status: Draft. Milestones are PR-sized coherent units; the Orchestrator
sequences them. SC0–SC4 are human-independent and ride entirely on shipped data
(SC0–SC3) or computed-on-read overlays (SC4). SC5–SC7 carry the decisions in
`risks-and-open-questions.md`. The spine is **SC0 → SC1 → SC4**; everything else
attaches to it.

## SC0 — Drill-down foundation — 🗓️ Planned (human-independent)

The navigation skeleton: a real entity page, a contextual sidebar, and a
peek-then-expand drawer — all over the existing projection, no new data.

- URL key codec next to `entityKey()` in `catalog/page.tsx`:
  `base64url(projectId  env  entityRef)`, with a decoder on the route.
- Route `app/(app)/orgs/[orgSlug]/catalog/[entityKey]/page.tsx` — fetches via
  the new `state.getOrgCatalogEntity`, renders the **Overview** tab (promote the
  current `EntityDetail`: relations + full provenance).
- `entity-nav.ts` + `buildEntityNav(orgSlug, entity)` mirroring
  `buildSettingsNav`; generalize the `inSettings` branch in `sidebar.tsx` into a
  resolver (settings | catalog-entity | product) reusing the swap+slide+back-row
  verbatim.
- Index drawer: row click sets `?entity=`; `Sheet` shows Overview + "Expand ↗"
  to the route; Escape/overlay clears the param. Keep the table/cards intact.
- Contract+SDK: `getOrgCatalogEntity(orgId, key)`; contract test + SDK test.

**Done when:** clicking a catalog row opens a URL-synced peek drawer; Expand
navigates to `/catalog/[entityKey]` whose left rail has swapped to the entity
context (identity header + tab links + related entities) with the back-chevron
returning to the catalog; the entity URL is shareable and back-button correct;
typecheck/lint/test green; no change to `OrgCatalogEntity` or the list endpoint.

## SC1 — Dependency graph — 🗓️ Planned

- Per-entity **Dependencies** tab: focused graph one hop from the entity, edges
  labeled by `relation.type`, nodes colored by `kind`, click-to-navigate.
- Org-level **Graph** view toggle on the index, laid out from the merged graph
  under the active filters.
- Graph library chosen (risks D2); bundle-cost budget respected (lazy-load the
  graph route chunk).

**Done when:** an entity's Dependencies tab renders its neighbors and navigates
on click; the index Graph toggle renders the filtered org graph; both are a
second renderer over `relations[]` with no new endpoint; the graph chunk is code
-split so the table path is unaffected.

## SC2 — Deployments / environments tab — 🗓️ Planned

- `state.listEntityEnvironments(orgId, entityRef)` → the env-scoped heads
  carrying the same `entityRef` (`headDigest`, `sourceCommit`, env).
- **Deployments** tab: a matrix of environment → snapshot/commit, linked to the
  project's Runs surface where a run exists for that env.

**Done when:** an entity present in multiple environments shows one row per env
with its commit/snapshot and a link to the relevant Runs; project-wide
(`null` env) entities render a single canonical row; the join to Runs degrades
gracefully when none exists.

## SC3 — Activity tab — 🗓️ Planned

- Reuse `listCatalogHeadHistory` + `getObject`; a client-side differ over the
  entity's slice of successive snapshots.
- **Activity** tab: a reverse-chronological changelog (added/removed relations,
  owner/lifecycle changes) with the commit/snapshot for each change.

**Done when:** the Activity tab shows the entity's change history derived from
head history; a known owner/relation change appears as a diff entry with its
commit; no new write path and no new endpoint beyond the existing history read.

## SC4 — Catalog insights (computed overlay) — 🗓️ Planned (human-independent)

- `state.getCatalogInsights(orgId)` computed on read from `catalog_entities`:
  counts + offending refs for missing-owner, missing-lifecycle, stale (head not
  advanced in N days), unowned/dangling dependencies.
- Index banner ("12 components missing owners · 5 stale") linking to a filtered
  view; a small Insights surface.

**Done when:** the index surfaces accurate coverage counts that deep-link to the
offending entities; the computation is read-only over the projection (no table,
no authoring); numbers match a hand-audit on a seeded org.

## SC5 — Scorecards / maturity (computed overlay) — 🗓️ Planned (decision: rule format)

- `catalog_scorecards` migration (sibling read-model; idempotent on
  `head_digest`); compute at catalog-head advance + on-demand recompute in
  `state-worker`.
- 2–3 built-in scorecards (Production-readiness, Ownership, API-quality) as
  pure predicates over snapshot + run/deploy signals; per-entity score + level
  and an org rollup.
- `getEntityScorecard` / `listScorecards`; **Health** tab + a scorecard-level
  column on the index; entitlement `feature.catalog_scorecards` + U7 upgrade UX.

**Done when:** every entity shows a score/level with per-check pass/fail
reasons; recompute is idempotent and triggered by head advance; the overlay
never mutates `catalog_entities`; gated orgs see the upgrade CTA, entitled orgs
see live scores; rollup matches per-entity aggregation.

## SC6 — Ownership & on-call — 🗓️ Planned (decision: ownership source)

- Intrinsic owner enriched in the snapshot/CLI (team ref), surfaced on Overview
  as a git-derived fact.
- `catalog_entity_annotations` overlay (operational only: team contact, Slack,
  escalation, runbook links), `get/putEntityAnnotations`, authored via console
  (`zod-form`) / CLI, rendered in a visually distinct "Operational" section.
- Policy `catalog.annotation.read|write`; audited writes.

**Done when:** an entity shows its git-derived owner *and*, separately, an
org-authored operational block whose provenance is visually unambiguous; editing
annotations never touches catalog content and survives a re-projection; writes
are audited and policy-gated.

## SC7 — Golden-path scaffolder — 🗓️ Planned (sub-epic candidate; gated on IG4)

- Template registry (`listCatalogTemplates`) + a parameter form (`zod-form`).
- `scaffold(templateId, params)` writes a repo/PR via the integrations token
  broker (IG4); returns a job/PR ref to follow. The new service enters the
  catalog through the normal `orun catalog push` — no console-authored row.
- Entitlement `feature.catalog_scaffolder`; policy `catalog.scaffold.run`;
  audited.

**Done when:** scaffolding a template from the console opens a PR (or creates a
repo) on a connected GitHub org via the broker, with a followable reference; the
resulting service appears in the catalog only after a real push; the flow fails
closed when integrations/entitlement are absent; no catalog row is ever written
by the console.

## SC8 — Console-to-standard polish — 🗓️ Planned (trails SC1/SC5/SC6)

- Per-user saved views + "My services" default (owned-team filter, needs SC6).
- Group-by (System · Domain · Owner · Kind); health columns (level/owner/last
  deploy, needs SC5/SC2); Table / Cards / Graph toggle (graph from SC1).
- Cmd-K: "Open service…", "Find owner of…", "Scaffold new service".

**Done when:** the catalog passes the same buyer-credibility bar the PX/U11
audits apply elsewhere (designed empty/loading/error states, no stubs, mobile-
credible); a verified-live walkthrough is recorded in `IMPLEMENTATION-STATUS.md`.

## Sequencing note

SC0 is the keystone and strictly first — every later milestone hangs tabs,
sidebar context, or columns off it. SC1 (graph) and SC4 (insights) are the
cheapest high-impact follow-ons and are human-independent. SC2/SC3 enrich the
entity page and can land in either order. SC5 (scorecards) is the headline
differentiator but waits on the rule-format decision; SC6 waits on the
ownership-source decision; both are read-mostly and invariant-safe. SC7 is the
detachable, highest-lift tail — gated on IG4 and a strong sub-epic candidate.
SC8 polish trails the data it surfaces. Worth shipping as a first reviewable
slice: **SC0 + SC1 + SC4** — a deep-linkable, graph-aware, quality-scored
catalog with zero new authoring and zero invariant risk.
