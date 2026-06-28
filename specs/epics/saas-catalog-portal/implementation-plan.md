# saas-catalog-portal — Implementation plan

CP0–CP4, each a self-contained, verifiable PR on
`claude/orun-cloud-catalog-2ailwz`. Verification gate for every milestone:
`pnpm typecheck` + `pnpm lint` (web-console-next) and `pnpm test`
(tests/web-console-next) green; visual diff against
[`design/Service_Catalog.dc.html`](./design/Service_Catalog.dc.html).

## CP0 — View-model + scorecard engine + contract enrichment

The testable foundation. No UI yet.

- Add additive optional fields to `OrgCatalogEntity` (`description?`, `system?`,
  `language?`, `tags?`) and the scorecard/insights response types to
  `packages/contracts/src/state.ts`; thread them through `packages/sdk`.
- `lib/catalog-portal/palette.ts` — the design's exact colour tokens (HEALTH /
  LIFE / TIER / greys), typed.
- `lib/catalog-portal/icons.ts` — the kind/check/mark icon path constants.
- `lib/catalog-portal/model.ts` — `CatalogService`, `decorateService`,
  `buildScorecard`, `buildSelected`, `rollup`, `needsAttention`, deploy/health
  formatting.
- `lib/catalog-portal/filter.ts` — `filterServices`, `sortServices`,
  `groupServices`.
- `tests/web-console-next/src/catalog-portal/{model,scorecard,filter}.test.ts`.

**Done when:** typecheck + lint + the new tests pass; the engine reproduces the
design's `scoreOf` / `tierOf` / `needsAttention` / `filtered` / `sortList` /
grouping outputs on the design's own sample data (a fixture mirroring the
design's `SERVICES` proves parity).

## CP1 — Index surface (header · tiles · toolbar · chips · banner · Table)

- `components/catalog/catalog-portal.tsx` — the surface; loads
  `listOrgCatalogEntities`, maps to `CatalogService[]`, owns filter/sort/group/
  view/selection state, renders header + tiles + toolbar + chips + banner + the
  active view.
- `components/catalog/portal/{header,metric-tiles,toolbar,filter-chips,incident-banner,table-view}.tsx`.
- Wire `app/(app)/orgs/[orgSlug]/catalog/page.tsx` to render the portal surface.
- Loading skeletons + the design's empty state.

**Done when:** the index renders the header, the four tiles (with the
attention-toggle behaviour), the toolbar (search + three facet selects + group +
view tabs), removable chips, the incident banner, and the sortable/groupable
Table — matching the design — against real `listOrgCatalogEntities` data; gates
green.

## CP2 — Board + Map views

- `components/catalog/portal/board-view.tsx` — lifecycle + infrastructure
  columns, cards per the design.
- `components/catalog/portal/map-view.tsx` — system-column layout, SVG edges,
  positioned nodes, selection highlight, health legend (reuses/extends
  `lib/catalog-portal/model.ts` layout helpers).
- View toggle switches all three; filter state shared.

**Done when:** Board and Map render and respond to the toolbar filters and
selection, matching the design; gates green.

## CP3 — Entity detail drawer

- `components/catalog/portal/detail-drawer.tsx` — scrim + slide-in sheet:
  identity, chips, ops stats, scorecard ring + checks, ownership + on-call,
  dependency neighborhoods, footer links. Driven by `buildSelected`.
- Open on select (row/card/node); close on scrim/✕/Escape; `?entity=` URL sync;
  "Expand" / double-click → deep route.

**Done when:** selecting any entity opens the drawer with the full designed
content (degrading per `design.md §4`); gates green.

## CP4 — Data wiring (enrichment + computed projections)

- Surface git-authored `description` / `system` / `language` end to end (pairs
  `orun-catalog-portal`): projection carries them; SDK/contract already expose
  them (CP0).
- `apps/state-worker`: compute the scorecard projection at head-advance and a
  deploy-recency/frequency join from the runs plane; expose
  `getCatalogInsights(orgId)` and `getEntityScorecard(orgId, key)` per
  `saas-service-catalog/design.md §4`. The console prefers these when present and
  falls back to the client-side engine otherwise.

**Done when:** with an enriched snapshot pushed, the index/drawer show real
description/system/language and a server-computed scorecard + deploy recency;
the client engine remains the documented fallback; gates green (worker tests +
console typecheck).

## Verification notes

- The Cloudflare/OpenNext production build is not exercised in CI here; the gate
  is `tsc` + `eslint` + Jest, which covers types, lint, and all pure logic. PRs
  state this explicitly.
- Each PR is merged after its gate is green, then the next milestone builds on
  the advanced base.
