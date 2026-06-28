# saas-catalog-portal — Design

Status: In progress. Normative on **visual fidelity** to
[`design/Service_Catalog.dc.html`](./design/Service_Catalog.dc.html); defers to
[`saas-service-catalog/design.md`](../saas-service-catalog/design.md) on
read-model architecture and the overlay/invariant model.

## 1. Anatomy of the design

The design is a single dark catalog surface (`#08080a` canvas, amber `#f59e0b`
accent) composed of, top to bottom:

1. **Shell** (sidebar + topbar) — *reference only*; the real shell is owned by
   `saas-console-ux`. We implement everything *inside* the catalog content
   column.
2. **Header** — an uppercase mono eyebrow ("Service catalog"), an `h1`
   ("All services"), a one-line description, and two actions: **Import**
   (outline) and **Register service** (amber primary).
3. **Metric tiles** — a 4-up grid: **Services** (`total` across `N` systems),
   **Ownership** (`%` + progress bar, colour-graded), **Production-ready**
   (`%` + green bar), and **Needs attention** (a *button* that toggles the
   attention filter; border/label go amber when active).
4. **Toolbar** — a search input; `kind` / `lifecycle` / `health` selects; a
   divider; a `group-by` select (none · team · system · lifecycle); and a
   right-aligned segmented **Table / Board / Map** toggle.
5. **Active filter chips** — `<result> of <total>`, one removable chip per active
   facet, and "Clear all".
6. **Incident banner** — shown when any entity has open incidents.
7. **Body** — one of three views (Table / Board / Map) with a **detail drawer**
   that overlays the body as a right-anchored sheet with a scrim.

### 1.1 The three views

- **Table** — a 7-column grid (`Service · Owner · Lifecycle · Health ·
  Readiness · Deps · Updated`) with sortable `Service / Health / Readiness /
  Updated` headers, optional sticky group headers (when grouped), a left
  selection bar on the active row, and an empty state.
- **Board** — Kanban columns by lifecycle (`Production · Experimental ·
  Deprecated`) plus an `Infrastructure` column for resources; each card shows
  icon, name, owner, health dot, tier chip, kind.
- **Map** — a dependency graph laid out in **system columns**: per-system
  vertical lanes, nodes positioned by `(column, row)`, SVG edges between
  dependencies, edges/nodes highlighting when the selection touches them, and a
  health legend.

### 1.2 The detail drawer

A `412px` right sheet (scrim + slide-in) with: identity header (icon, name,
kind badge, ref, close); description; lifecycle / health / language / system
chips; **operational stats** (SLO vs target · open incidents · deploys/wk +
last-deploy) shown only for non-resources; the **production-readiness
scorecard** (a conic progress ring with the numeric score, the tier chip,
pass/warn/fail tallies, and the per-check list); **ownership** (avatar, team,
sub-label) + an on-call row when present; **dependencies** (depends-on /
used-by mini-rows with health dots, "View map"); and a footer of quick links
(Repo · Dashboards · Runbook).

## 2. The view-model layer (CP0)

The design's `<script>` is a self-contained component with hardcoded `SERVICES`.
We reproduce its *logic* as a pure, dependency-free, unit-tested module so the
table, board, map, drawer, and tests share one mapping — mirroring the existing
`lib/catalog-*.ts` convention.

`lib/catalog-portal/model.ts` — the core:

```
CatalogService            // normalized per-entity input (git + enrichment + runtime)
  ├─ from OrgCatalogEntity (entityRef, kind, name, owner, lifecycle, relations,
  │   provenance) + optional enrichment (description, system, language)
  └─ + optional runtime signals (health, slo, sloTarget, incidents,
      deploysPerWeek, lastDeployHours) — all nullable

decorateService(svc, ctx) // → the row/card/node shape: icon key, owner
                          //   initials/colour, lifecycle tone, health tone,
                          //   readiness tier+score+bar, deps label, updated label
buildScorecard(svc)       // checks[] → pass/warn/fail → score (0–100) → tier
                          //   (Gold ≥85 · Silver ≥70 · Bronze) — §3
buildSelected(svc, all)   // the full drawer view-model (ops, scorecard, owner,
                          //   on-call, dependsOn/usedBy neighborhoods)
rollup(services)          // metric tiles: totals, ownedPct, readyPct,
                          //   attentionCount, incident summary, systemsCount
needsAttention(svc)       // non-resource AND (unhealthy OR unowned)
```

`lib/catalog-portal/filter.ts` — `filterServices` (kind / lifecycle / health /
attention / free-text) + `sortServices` (name / health / readiness / deploy) +
`groupServices` (none / team / system / lifecycle), matching the design's
`filtered()` / `sortList()` / grouping exactly, including the Unowned/No-lifecycle
sink-to-bottom ordering.

`lib/catalog-portal/palette.ts` — the design's exact colour constants (`HEALTH`,
`LIFE`, `TIER`, the canvas/border greys) as typed tokens, so every component
reads one source of truth and tests assert the mapping.

Everything in `lib/catalog-portal/` is pure and lives under
`tests/web-console-next/src/catalog-portal/*.test.ts`.

## 3. The scorecard engine (CP0, design-faithful)

The design defines eight checks and scores them; we reproduce it exactly and
make it honest:

```
CHECKS = owner · oncall · slo · runbook · tests · vulns · docs · pipeline
status(check, svc):
  fail  if a hard signal is absent (e.g. owner check & no team)
  warn  if a soft signal is weak
  pass  otherwise
score = round(100 · Σ(pass:1, warn:.5, fail:0) / 8)
tier  = Gold ≥85 · Silver ≥70 · Bronze < 70   (resources: no score)
```

v1 derives each check from signals we actually have — owner presence, lifecycle
presence, description/docs presence, dependency resolution, and (CP4) run/deploy
recency + the annotations overlay. Checks with no signal yet are reported
`warn` (unknown), never a false `pass`. The same engine powers the index
`Readiness` column, the board tier chip, and the drawer scorecard.

## 4. Data sourcing & graceful degradation

| Field | Strategy |
|---|---|
| name · kind · ref · lifecycle · relations | `OrgCatalogEntity`, today |
| description · system · language | optional fields on `OrgCatalogEntity` (CP4 + `orun-catalog-portal`); UI hides the chip / uses `—` when absent |
| owner / team | `owner` string → team identity (initials, colour); `null` → "Unowned" with the dashed avatar from the design |
| on-call | SC6 annotations overlay; the on-call row renders only when present |
| readiness · insights · attention | computed (CP0) — always available |
| health | runtime; derived best-effort from recent run status (CP4). Absent → resources render "Managed"; non-resources render an "unknown" dot. Health **select** still filters whatever is present. |
| SLO · incidents | runtime; no source yet → the ops grid degrades (the design's `hasOps`/`incColor` paths). Surfaced when a monitoring source exists. |
| deploys/wk · last-deploy | runtime; derived from successful runs in the runs plane (CP4). Absent → `—`. |

The principle: **render the designed layout always; fill real values where a
source exists; degrade honestly (—/hidden/unknown) where it does not — never
fabricate.** The design's own logic already encodes every degraded path, so
fidelity and honesty do not conflict.

## 5. Palette & styling

The catalog content is a **fixed dark data surface** matching the design's exact
hexes, independent of the app's light/dark theme (the app default is the dark
amber theme that already mirrors these colours). We use Tailwind utility classes
with arbitrary values for the design's specific greys (e.g. `bg-[#0d0d10]`,
`border-[#1c1c20]`) and the existing `primary` token for the amber accent
(`#f59e0b` ≡ `--primary`). This keeps everything inside the Tailwind system (no
inline `style` objects) while matching the design pixel-for-pixel. The exact
constants live in `palette.ts`; components reference them or their Tailwind
equivalents.

Key constants (from the design): canvas `#08080a`; card `#0d0d10`/`#0c0c0f`;
borders `#1c1c20`/`#1a1a1e`/`#26262b`; text `#fafafa`/`#e4e4e7`/`#a1a1aa`/
`#71717a`/`#52525b`; accent `#f59e0b`; health green `#34d399`, amber `#fbbf24`,
red `#f87171`; tiers Gold `#f59e0b` · Silver `#9ca3af` · Bronze `#c2855b`.

## 6. Component map (where the work lands)

| Area | Files |
|---|---|
| View-model | `lib/catalog-portal/{model,filter,palette,icons}.ts` (new, pure) |
| Index page | `components/catalog/catalog-portal.tsx` (new top-level surface) wired from `app/(app)/orgs/[orgSlug]/catalog/page.tsx` |
| Header + tiles | `components/catalog/portal/{header,metric-tiles}.tsx` |
| Toolbar + chips | `components/catalog/portal/{toolbar,filter-chips,incident-banner}.tsx` |
| Table view | `components/catalog/portal/table-view.tsx` |
| Board view | `components/catalog/portal/board-view.tsx` |
| Map view | `components/catalog/portal/map-view.tsx` |
| Drawer | `components/catalog/portal/detail-drawer.tsx` |
| Contracts/SDK | `packages/contracts/src/state.ts` (optional enrichment + scorecard/insights types), `packages/sdk/src/state.ts` |
| Backend (CP4) | `apps/state-worker` (projection enrichment, scorecard compute, insights/scorecard reads) |
| Tests | `tests/web-console-next/src/catalog-portal/*.test.ts` |

The existing `lib/catalog-*.ts` and `components/catalog/*` (the calm-monochrome
browser) are superseded by the portal surface on the index route; they remain
referenced by the deep entity route until that route adopts the portal drawer
content in a later pass. No existing pure helper is deleted without a test
migration.

## 7. Interaction & state

All filter/sort/group/view/selection state is local component state mirroring the
design's `state` object, with the selected entity also reflected in the URL
(`?entity=<key>`) so a peek is shareable and back-button correct — reusing the
existing `encodeEntityKey` codec. Selecting a row/card/node opens the drawer;
the scrim/✕/Escape closes it; "Expand" / double-click still routes to the deep
entity page. Keyboard triage (↑/↓/↵/Esc) from the existing index is preserved.
