# saas-service-catalog — Design

Status: Draft. The durable contract for the catalog read-model stays
`components/18-state.md`; this epic evolves the *experience* and adds *sibling*
read-only overlays. Nothing here authors catalog content.

## 1. The invariant this design is built around

From `components/18-state.md`:

> Catalog heads are the only mutable pointers in the object plane… the
> read-model (`catalog_entities`) is derived, never authored, and idempotently
> rebuildable from the snapshot blob — the platform never edits catalog content.
> Catalog authoring — the console never writes catalog content; the platform
> renders what git produced (provenance is verifiably drift-free).

This is the platform's honesty guarantee, and it is **non-negotiable**. The
design constraint that follows: a "world-class catalog" cannot be achieved by
making the console author entities (the obvious Backstage-UI path). Instead,
every enrichment falls into exactly one of four sanctioned shapes:

1. **Navigation/experience** over the existing projection (SC0–SC3) — no new
   data, just routes, a sidebar, a graph, and tabs over `OrgCatalogEntity`.
2. **Computed overlays** (SC4 insights, SC5 scorecards) — derived read-only
   data in sibling tables, rebuildable from the snapshot + run/deploy signals,
   keyed back to the entity. Never edits catalog content.
3. **Git-authored snapshot data** (SC6 intrinsic ownership) — richer fields the
   *git source* already declares (Backstage `catalog-info.yaml`-style),
   surfaced by extending what `orun catalog push` projects. The source of truth
   stays git.
4. **A separated operational-annotations overlay** (SC6 on-call/Slack) and a
   **git-writing scaffolder** (SC7) — org-authored *operational* metadata that
   is explicitly **not** catalog content, and a self-service flow that writes a
   *repo/PR*, letting the catalog reflect the result through the normal push.

If a proposed feature does not fit one of these four, it is out of scope.

## 2. Current state (what SC0 starts from)

`apps/web-console-next/src/app/(app)/orgs/[orgSlug]/catalog/page.tsx`:

- Loads `client.state.listOrgCatalogEntities(orgId, filters)` with keyset
  "Load more"; filters: project · kind · owner · environment · free-text `q`.
- Renders a responsive table (desktop) / card list (mobile).
- Selecting a row sets local `selected` state and renders an **inline
  `EntityDetail` card below the table** — relations + provenance. No URL, no
  deep link, no sidebar context.

`OrgCatalogEntity` (`packages/contracts/src/state.ts`):

```
entityRef          // "component:default/api" — contains ':' and '/'
kind               // Component | API | Resource | System | Domain | Group
name, owner, lifecycle
relations[]        // { type, targetRef }
sourceProjectId, sourceEnvironment (null = project-wide), sourceCommit
headDigest         // snapshot digest this row was projected from
```

Merged-graph identity is the triple `(sourceProjectId, sourceEnvironment,
entityRef)` — already encoded by `entityKey()` in `page.tsx` as
`${sourceProjectId}:${sourceEnvironment ?? ""}:${entityRef}`.

## 3. Drill-down: the hybrid drawer + route (SC0)

### 3.1 The URL key codec

The route key must round-trip the identity triple, and `entityRef` itself
contains `:` and `/`. A raw path segment is therefore wrong. Encode the triple
into one opaque, URL-safe segment:

```
entityKeyParam = base64url(`${sourceProjectId}${sourceEnvironment ?? ""}${entityRef}`)
```

(`` = ASCII Unit Separator — never appears in the inputs.) Decode on the
detail route to recover the triple, then fetch. Place the codec next to the
existing `entityKey()` so list and route share one identity definition. Route:

```
apps/web-console-next/src/app/(app)/orgs/[orgSlug]/catalog/[entityKey]/page.tsx
```

A single dynamic segment (not a catch-all) keeps routing unambiguous.

### 3.2 The drawer (quick peek)

On the index, clicking a row sets `?entity=<entityKeyParam>` (URL-synced, so a
peek is itself shareable and back-button correct). A `Sheet`
(`components/ui/sheet.tsx`, already used by the mobile nav) slides in with the
Overview content and an **"Expand ↗"** to the full route. Escape / overlay
click clears the query param. This is the Linear/Vercel peek-then-expand model:
fast browse, full page when you commit.

### 3.3 The contextual sidebar (generalize, don't invent)

`sidebar.tsx` already swaps the entire left rail when `inSettings` is true
(`pathname.startsWith('/orgs/{org}/settings')`), with a back chevron, a centered
title, a flat link list, and a directional slide (`animate-sidebar-in-right`).
SC0 generalizes this into an **entity rail** triggered by
`pathname.startsWith('/orgs/{org}/catalog/')` with a non-empty key:

- A `buildEntityNav(orgSlug, entity)` (mirroring `buildSettingsNav`) returns the
  identity header (name, kind badge, owner, lifecycle) + the tab links
  (Overview · Dependencies · Deployments · Activity) + a "Related entities"
  group (top relations as quick links).
- The rail-swap branch in `sidebar.tsx` becomes a small resolver: settings →
  settings nav, catalog-entity → entity nav, else → product nav. The animation,
  back-row, and active-link logic are reused verbatim.

This is the literal answer to "side bar showing more info selected": selecting
an entity contextualizes the whole rail to it, exactly as Settings does today.

### 3.4 Tabs

Tabs render under the entity route using `components/ui/tabs.tsx`. The tab is in
the URL (`/catalog/[entityKey]/[tab]` or `?tab=`) so each tab deep-links. SC0
ships **Overview** (promote `EntityDetail`); SC1–SC3 add the rest.

## 4. Contract & SDK additions

Additive only (no breaking change to `OrgCatalogEntity` or
`listOrgCatalogEntities`). In `packages/contracts/src/state.ts` + `packages/sdk`:

| Milestone | Contract | Notes |
|---|---|---|
| SC0 | `getOrgCatalogEntity(orgId, key) -> OrgCatalogEntity` | Single-entity fetch by identity triple; the route's first paint. Falls back to a list-filter if the worker prefers. |
| SC2 | `listEntityEnvironments(orgId, entityRef) -> { environment, headDigest, sourceCommit }[]` | The same `entityRef` across env-scoped heads → the deployments matrix. |
| SC3 | reuse `listCatalogHeadHistory` + `getObject` | Diff successive snapshots for the entity's slice — no new endpoint, just a client-side differ. |
| SC4 | `getCatalogInsights(orgId) -> CatalogInsights` | Computed coverage summary (counts + offending entity refs). |
| SC5 | `getEntityScorecard(orgId, key)` · `listScorecards(orgId)` | Per-entity scores + the org rollup. |
| SC6 | `getEntityAnnotations` · `putEntityAnnotations` (operational only) | The **only** write endpoint in the epic, and it writes the *annotations overlay*, never `catalog_entities`. |
| SC7 | `listCatalogTemplates` · `scaffold(templateId, params)` | Returns a job/PR ref; the write lands in git via integrations. |

## 5. Overlay schema (SC4–SC6)

New tables in the `state` schema (migrations under `packages/db/src/migrations`,
each org-scoped per the `org_id + project_id` rule, with a manifest entry +
checksum). All are **sibling** to `catalog_entities` — derived or operational,
never the catalog itself.

- `catalog_scorecards` (SC5) — derived: `(org_id, source_project_id,
  source_environment, entity_ref, scorecard_id)` → `score`, `level`,
  `checks jsonb`, `head_digest`, `computed_at`. Rebuildable from the snapshot +
  run/deploy signals; idempotent on `head_digest`.
- `catalog_entity_annotations` (SC6) — operational overlay, **explicitly not
  catalog content**: `(org_id, entity_ref)` → `team`, `slack_channel`,
  `escalation`, `links jsonb`, `updated_by`, `updated_at`. Authored via the
  console/CLI; clearly labeled in the UI as operational metadata distinct from
  the git-derived entity. Keyed by `entity_ref`/owner, not by the projection row
  id, so it survives re-projection.
- Insights (SC4) need **no table** — computed on read from `catalog_entities`
  (and annotations once SC6 lands), cached briefly. Promote to a materialized
  summary only if read cost demands it.

Policy actions (deny-by-default, alongside the existing `catalog.read`):
`catalog.scorecard.read`, `catalog.annotation.read|write`,
`catalog.scaffold.run`. Entitlements: `feature.catalog_scorecards`,
`feature.catalog_scaffolder` (premium), gating via the materialized per-org seam
and U7 upgrade UX.

## 6. Dependency graph (SC1)

`relations[]` is already a typed edge set. Per-entity: a focused graph centered
on the entity, one hop out, edges labeled by `relation.type`, nodes colored by
`kind`, click-to-navigate. Org-level: a "Graph" view toggle on the index that
lays out the merged graph (filtered by the existing toolbar). Library decision
in `risks-and-open-questions.md` (lean React Flow for the interactive case; a
lighter static SVG for the entity mini-map is acceptable if bundle cost bites).
No new data — the graph is a second renderer over the projection.

## 7. Scorecards / maturity (SC5)

The Cortex/OpsLevel differentiator, made invariant-safe by being a **computed
overlay**, not authored state. A scorecard is a named set of checks, each a pure
predicate over signals the platform already has:

- **Snapshot signals**: has owner, has lifecycle, has a `description`/docs link,
  declared dependencies resolve to known entities, kind-appropriate relations
  (e.g. an `API` is `providedBy` a `Component`).
- **Operational signals** (once SC6): has a team + escalation target.
- **Runtime signals**: recent successful Runs for the entity's project/env,
  deploy recency (joins the run-coordination plane).

Each entity gets a score + maturity level (e.g. Bronze/Silver/Gold) per
scorecard; the org gets a rollup. Computed at catalog-head advance (same trigger
that rebuilds the projection) and on-demand recompute. The rule set ships as a
small declarative spec (format decision is open — see risks); v1 can hardcode
2–3 scorecards (Production-readiness, Ownership, API-quality) to ship the
surface before the authoring story exists.

## 8. Ownership & on-call (SC6)

Split cleanly to respect the invariant:

- **Intrinsic ownership** (the team that owns the service) is a *catalog fact* —
  it belongs in git (`catalog-info.yaml`-style) and flows through
  `orun catalog push`. `owner` already exists; SC6 enriches the snapshot/CLI to
  carry a richer owner (team ref) and surfaces it on Overview. Source of truth
  stays git.
- **Operational contact** (Slack channel, escalation/on-call target, runbook
  links) is *not* a catalog fact and changes on an operational cadence
  independent of code. It lives in `catalog_entity_annotations`, authored via
  the console/CLI, and is rendered in a visually distinct "Operational" section
  so the git-derived vs. org-authored boundary is legible to the user.

We surface escalation targets; we do not page. Paging/incident delivery is out
of scope (a notifications/integrations concern if ever wanted).

## 9. Golden-path scaffolder (SC7)

The Backstage Software Templates / Port self-service story — and the one feature
that writes. It stays invariant-safe because **it writes git, not the catalog**:
a template + parameters produces a repository (or a PR into one) via the
integrations token broker (IG4); the new service then appears in the catalog
through the *normal* `orun catalog push` path. The console never inserts a
catalog row.

Shape: a template registry (`listCatalogTemplates`), a parameter form
(reuse `components/ui/zod-form.tsx`), and a `scaffold(templateId, params)` action
that returns a job/PR reference to follow. Placement and the dormant-seam
question are in risks; SC7 is a sub-epic candidate and should not start before
IG4 (the broker) is real or stubbed behind a provider seam.

## 10. Index polish (SC8)

Trails the data it surfaces: per-user **saved views** + a **"My services"**
default (filter by the viewer's owned teams once SC6 lands); **group-by**
(System · Domain · Owner · Kind) turning the flat list into a navigable
hierarchy; **health columns** (scorecard level, owner, last deploy) once SC5/SC6
exist; **Table / Cards / Graph** view toggle (graph from SC1); Cmd-K actions
("Open service…", "Find owner of…", "Scaffold new service") via the existing
`command-registry.ts`. None of these are foundational, which is why they land
last — they compose the earlier milestones into a polished surface.

## 11. Console file map (where the work lands)

| Area | Files |
|---|---|
| Index | `app/(app)/orgs/[orgSlug]/catalog/page.tsx` (drawer + view toggles + group-by) |
| Entity route | `app/(app)/orgs/[orgSlug]/catalog/[entityKey]/page.tsx` + tab subtrees |
| Sidebar | `components/shell/{nav-items,sidebar}.ts(x)` (+ new `entity-nav.ts`) — generalize the rail-swap |
| Drawer | `components/ui/sheet.tsx` (reused) |
| Detail content | promote/extract `EntityDetail` → `Overview` tab; new `Graph`, `Deployments`, `Activity`, `Health` tabs |
| Contracts/SDK | `packages/contracts/src/state.ts`, `packages/sdk/src/state.ts` |
| Backend | `apps/state-worker` (overlay handlers/repos, scorecard compute at head-advance), `packages/db/src/migrations/*` |
| CLI | `packages/cli` (richer `catalog push` fields SC6; `catalog scaffold` SC7) |
| Contract docs | extend `specs/components/18-state.md` (overlays as sibling read-models; the annotations boundary) |
