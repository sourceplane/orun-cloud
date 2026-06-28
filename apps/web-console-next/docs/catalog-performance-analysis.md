# Catalog & Console Performance Analysis

_Scope: `apps/web-console-next` — the Orun Cloud web console. Focus on the
**Catalog** section's response quickness, plus console-wide patterns that hurt
the "snappy SaaS" feel. Every finding cites the file and line it lives in, the
root cause, a concrete fix, and the expected impact._

---

## TL;DR — the one thing to fix first

The catalog index (`CatalogPortal`) is the **only major surface in the console
that does not use the react-query cache**. It hand-rolls `useState` +
`useEffect` and, on every mount, **serially pages the entire org graph** (up to
50 sequential round-trips of 100 entities each) before it renders a single row.
Everything else in the app (`useApiQuery`) gets stale-while-revalidate caching
and paints instantly on revisit; the catalog throws that away and shows a
skeleton every single time.

Fixing just the data layer for the catalog index — cache it, parallelize/stream
the pages, memoize the per-row decoration, and debounce search — removes the
large majority of the perceived latency. Details below, ranked by impact.

---

## How the catalog loads today (data flow)

```
/orgs/[slug]/catalog
  └─ OrgScope (useOrgBySlug → cached `orgs` query)         ✅ cached
       └─ CatalogPortal
            └─ React.useEffect → load()                    ❌ NOT cached
                 for page in 0..50:                         ❌ SERIAL waterfall
                   await client.state.listOrgCatalogEntities(orgId, {limit:100, cursor})
                 setEntities(all)                           ❌ paints only after ALL pages
            └─ toServices → buildContext → rollup           ❌ re-run on every render
            └─ filter → sort → group → board → map → chips  ❌ re-run on every keystroke
            └─ TableView renders ALL rows                   ❌ no virtualization
                 each Row: decorate(s) → scoreOf → computeChecks   ❌ per-row, per-render
```

The deep entity route (`/catalog/[entityKey]`) is a **second, independent
implementation** (`CatalogWorkbench`) that re-fetches a narrowed query even
though the index already had that entity in memory/cache.

---

## Findings — Catalog, ranked by impact

### C1 — Catalog index bypasses the query cache → full reload + skeleton on every visit ⭐️ highest impact

**Where:** `src/components/catalog/catalog-portal.tsx:60-105` (the `load`
callback + `useState`/`useEffect`).

**Symptom:** Navigating away and back to the catalog always shows the skeleton
and re-downloads the whole graph. By contrast, projects, members, billing, etc.
paint instantly from cache because they use `useApiQuery` (`src/lib/query.ts`).

**Root cause:** `CatalogPortal` calls `wrap(() => client.state.listOrgCatalogEntities(...))`
directly inside an effect and stores results in component state. The
`QueryClient` is configured with `staleTime: 30s` / `gcTime: 5m`
(`src/app/providers.tsx:18-19`) — but the catalog never participates.

**Fix:** Route the load through react-query. Add a key and a fetcher that pages
internally, so the whole graph becomes one cached entry:

```ts
// query-keys.ts
orgCatalog: (orgId: string) => ["orgCatalog", orgId] as const,

// catalog-portal.tsx
const { data: entities = [], loading, error, reload } = useApiQuery(
  qk.orgCatalog(orgId),
  () => wrap(() => fetchAllOrgCatalogEntities(client, orgId)),
);
```

**Impact:** Revisits become instant (cache hit, background revalidate). This is
the single biggest perceived-latency win.

---

### C2 — Serial pagination waterfall blocks first paint ⭐️ high impact

**Where:** `src/components/catalog/catalog-portal.tsx:74-99` — the
`for (page…) { await … }` loop.

**Symptom:** Nothing renders until the *last* page resolves. An org with 500
entities = 5 sequential network round-trips (latency × 5) before first paint;
2,000 entities = 20 RTTs. Each `await` blocks the next request.

**Root cause:** The endpoint is keyset/cursor paginated (the next cursor is only
known after the previous response), so pages *cannot* be requested in parallel
as written. Two independent problems compound: (a) the user sees nothing until
all pages land; (b) keyset forces serialization.

**Fixes (pick based on scale):**

1. **Progressive render (cheapest, big win):** call `setEntities` after *each*
   page instead of only at the end, so rows stream in as pages arrive. The list
   is usable after page 1 (~100 rows) while the rest fills in.
2. **Render page 1, lazy-load the rest:** treat page 1 as the data for first
   paint; continue paging in the background and merge. Combine with C1 so the
   merged result lands in the cache.
3. **Server-side aggregate (best long-term):** add a counts/summary endpoint so
   the metric tiles (`rollup`) don't require the full client-side graph, and let
   the table page on demand. The metric tiles currently *force* a full load
   because `rollup`/`buildContext` need every entity.

**Impact:** First meaningful paint drops from "N round-trips" to "1 round-trip"
for the common case.

---

### C3 — Per-row decoration recomputes scorecards on every render ⭐️ high impact

**Where:** `src/components/catalog/portal/table-view.tsx:180-192` (`renderRows`
calls `decorate(s)` inline) → `decorateService` →
`scoreOf` → `computeChecks` (`src/lib/catalog-portal/model.ts:832-867,951`).

**Symptom:** Janky scroll / slow re-render with a few hundred services. Each
selection change, keystroke, or sort re-runs the **8-check scorecard for every
row** — `decorate` is not memoized and `TableView` re-renders on every parent
state change (selection lives in the parent).

**Root cause:** `decorate` is a `useCallback` bound to `ctx`, but it's *invoked*
fresh for every row on every render. `scoreOf` → `computeChecks` builds an
8-element array and reduces it per row, per render. Selecting a row
(`setSelectedKey`) re-renders the entire `TableView`, re-decorating all rows.

**Fixes:**
- Memoize decoration once per dataset, not per render:
  `const decorated = useMemo(() => filtered.map(s => decorateService(s, ctx)), [filtered, ctx])`,
  and pass `DecoratedService[]` into the views instead of `decorate`.
- Wrap `Row` in `React.memo` (its props are now primitives + a stable decorated
  object) so flipping one row's `selected` doesn't re-render the other 999.
- Cache `scoreOf`/`computeChecks` results on the service (or via a `WeakMap`) so
  they're computed once.

**Impact:** Sorting/selecting/typing goes from O(rows × checks) per interaction
to O(1) re-render of the changed rows.

---

### C4 — Search input has no debounce; every keystroke re-runs the full pipeline ⭐️ high impact

**Where:** `src/components/catalog/portal/toolbar.tsx:84-90`
(`onChange={(e) => setFilters({ query: e.target.value })}`) feeding
`src/components/catalog/catalog-portal.tsx:107-115` (`filtered`/`grouped`/`board`/`map`).

**Symptom:** Typing in the catalog search feels heavy on large orgs — each
character triggers `filterServices` (+ `ownerLabel`/`lifecycleKey` per row) →
`sortServices` (which calls `scoreOf` per comparison for readiness sort) →
`groupServices` → `buildBoard` → `buildMap` → re-decorate all rows.

Note: the *old* `CatalogWorkbench` already solved this with `useDebounced`
(`catalog-workbench.tsx:53-60,142-144`) — the newer `CatalogPortal` regressed it.

**Root cause:** `filters.query` updates synchronously on each keystroke and is a
dependency of every downstream `useMemo`.

**Fix:** Debounce the query before it drives the memos (reuse the existing
`useDebounced` hook), and/or split state so the input stays controlled at full
speed while the *filtering value* is debounced:

```ts
const [queryInput, setQueryInput] = React.useState("");
const query = useDebounced(queryInput, 200);
// filters.query := query (debounced); input value := queryInput (instant)
```

**Impact:** Typing stays at 60fps regardless of org size; the expensive pipeline
runs at most ~5×/sec instead of per-keystroke.

---

### C5 — No list virtualization; all rows are in the DOM

**Where:** `table-view.tsx:180-192` (Table), `portal/board-view.tsx`,
`portal/map-view.tsx` — all map the full list to DOM nodes.

**Symptom:** With thousands of entities, the table mounts thousands of
`<button>` rows (each ~10 nested spans). DOM size alone slows layout, scroll,
and every re-render.

**Fix:** Virtualize the row list (e.g. `@tanstack/react-virtual` — already in the
TanStack family the app uses) so only ~30 visible rows mount. The fixed-height
frame (`FRAME = h-[calc(100dvh-6rem)]`) and the single scroll container make
this a clean drop-in.

**Impact:** Constant render cost regardless of catalog size; smooth scroll.

---

### C6 — Selection drives a router navigation instead of local state

**Where:** `catalog-portal.tsx:117-128` (`setSelectedKey` → `router.replace`),
also keyboard nav in `catalog-workbench.tsx:252-282`.

**Symptom:** Clicking a row (or arrow-keying through the list) calls
`router.replace(...)`, which re-runs `useSearchParams` subscribers across the
subtree. It's heavier than a `useState` toggle and can feel laggy under rapid
keyboard triage.

**Trade-off:** The `?entity=` param is deep-linkable, which is a real feature —
so don't just drop it. Keep the URL as the source of truth for the *opened*
entity, but drive the fast-changing *hover/keyboard cursor* with local state and
only sync to the URL on commit (open) or debounced.

**Impact:** Arrow-key scrubbing through a long list stays instant.

---

### C7 — Entity detail route refetches what the index already has

**Where:** `catalog-workbench.tsx:523-533` (`EntityWorkbench` issues a fresh
`listOrgCatalogEntities` narrowed query) vs. the index's already-loaded graph.

**Symptom:** Double-clicking a row to drill in shows a skeleton and a new
network request even though the entity was on screen a moment ago.

**Fix:** Once C1 lands, seed the entity query from the cached org-catalog list
(react-query `initialData` / `getQueryData(qk.orgCatalog(orgId))` → find the
entity) so the deep view paints instantly and revalidates in the background.
Also `prefetch` on row hover/focus (the `usePrefetch` helper already exists in
`src/lib/query.ts:88-101` but isn't used here).

**Impact:** Drill-in becomes instant; no skeleton flash.

---

### C8 — All three views + the drawer are eagerly bundled

**Where:** `catalog-portal.tsx:46-52` imports `TableView`, `BoardView`,
`MapView`, `DetailDrawer` statically; only one view renders at a time.

**Symptom:** The map/board view code (SVG layout in `buildMap`/`map-view.tsx`)
ships in the initial catalog bundle even for users who only ever use the table.

**Fix:** `next/dynamic` the non-default views and the drawer:
```ts
const MapView = dynamic(() => import("./portal/map-view").then(m => m.MapView));
```
There are currently **zero** `next/dynamic`/`React.lazy`/`loading.tsx` usages in
the app (verified by grep) — code-splitting is an untapped lever console-wide.

**Impact:** Smaller initial JS for the catalog route → faster TTI.

---

## Findings — Console-wide

### G1 — No route-level `loading.tsx` anywhere

**Where:** `find src/app -name loading.tsx` → none.

Next.js App Router streams a `loading.tsx` boundary instantly while the route's
client JS hydrates and data loads. Without it, route transitions wait on the
client component tree. Add `loading.tsx` skeletons for the heavy routes
(catalog, projects, runs) for an instant transition shell.

### G2 — No `optimizePackageImports` for icon/UI barrels

**Where:** `next.config.mjs` (no `experimental.optimizePackageImports`).

`lucide-react` and the Radix packages are barrel imports. Enabling
`experimental: { optimizePackageImports: ["lucide-react", "@radix-ui/react-*"] }`
lets Next tree-shake to only the used icons/primitives, shrinking every bundle.

### G3 — No prefetch-on-intent for data

`usePrefetch` (`src/lib/query.ts:88-101`) exists but is unused. Wiring it to
hover/focus on nav links and list rows (projects list, catalog rows, org
switcher) warms the cache before the click so the next page is a cache hit.
Next's `<Link>` prefetches the route JS, but not the *data* — this closes that
gap.

### G4 — `useMediaQuery` / `useDebounced` duplicated, and a layout-shift risk

`useMediaQuery` (`catalog-workbench.tsx:63-73`) initializes to `false` on first
render then corrects in an effect → a brief wrong-layout flash on wide screens.
Hoist these hooks to `src/lib` (shared), and initialize `useMediaQuery` from
`window.matchMedia` lazily to avoid the flash.

### G5 — `force-dynamic` at the root opts the whole app out of static shells

**Where:** `src/app/layout.tsx` (`export const dynamic = "force-dynamic"`).

Justified by the all-client auth tree, but it means no static prerender even for
the truly static chrome. Lower-priority, but worth revisiting: a static shell +
client islands would let the frame paint before any JS executes.

---

## Tooling & measurement recommendations

You can't keep a SaaS snappy without a feedback loop. Recommended toolchain:

1. **Bundle visibility:** add `@next/bundle-analyzer` and a
   `pnpm --filter web-console-next analyze` script. Gate PRs on first-load JS for
   the catalog route.
2. **Field metrics (RUM):** wire `useReportWebVitals` (Next built-in) to emit
   LCP / INP / CLS to your metering/analytics pipeline. INP is the metric that
   captures the "snappy" feel (input → paint latency) — it directly measures
   C3/C4/C6.
3. **React render profiling:** use the React DevTools Profiler "highlight
   re-renders" while typing in catalog search to confirm C3/C4 before/after.
   Consider the React Compiler (RC) for this React 19 app — it auto-memoizes and
   would address much of C3 structurally.
4. **Lab budgets in CI:** Lighthouse CI (`@lhci/cli`) with a performance budget
   on the catalog and projects routes, run on PRs.
5. **react-query devtools** in dev to watch cache hits/misses and confirm C1/C7
   land (the catalog should show a cache hit on revisit).
6. **Server timing:** confirm the `listOrgCatalogEntities` endpoint is keyset-
   indexed and returns `limit` honored at 100; consider a `?count` / summary
   endpoint to unblock C2 option 3.

---

## Prioritized roadmap

| # | Change | Effort | Impact | Risk |
|---|--------|--------|--------|------|
| C1 | Move catalog index onto `useApiQuery` cache | S | ⭐️⭐️⭐️ | Low |
| C4 | Debounce catalog search | S | ⭐️⭐️⭐️ | Low |
| C3 | Memoize decoration + `React.memo(Row)` | S–M | ⭐️⭐️⭐️ | Low |
| C2 | Progressive/streamed paging (render page 1) | M | ⭐️⭐️ | Low |
| C7 | Seed entity route from cache + prefetch on hover | S | ⭐️⭐️ | Low |
| C6 | Local-state selection cursor, URL on commit | M | ⭐️⭐️ | Med |
| C5 | Virtualize the row lists | M | ⭐️⭐️ | Med |
| G1 | Add `loading.tsx` for heavy routes | S | ⭐️⭐️ | Low |
| G2 | `optimizePackageImports` | XS | ⭐️ | Low |
| C8 | `next/dynamic` board/map/drawer | S | ⭐️ | Low |
| G3 | Prefetch-on-intent | S | ⭐️ | Low |

**Recommended first PR (highest value / lowest risk):** C1 + C4 + C3 together —
they share the same file, are independently testable, and remove the bulk of the
perceived latency. Then C2 and C7 for first-paint and drill-in.

---

_Analysis only — no behavioral code changes are included in this document. Each
finding is written so it can be lifted directly into an implementation PR._
