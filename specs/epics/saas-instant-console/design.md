# saas-instant-console — Measurement Record & Root-Cause Analysis

Status: Normative measurement record (2026-07-23)

Method: live prod walkthrough of `app.orun.dev` (workspace `ogpic`, warm CDN,
authenticated) instrumented via the Performance API — navigation timing, paint
timing, per-resource timings, and per-route fetch traces captured on every
sidebar surface, plus dropdowns, view switches, the command palette, and an
entity detail page. Code references verified against `main` @ `f478c18`.

## 1. The headline numbers

| Metric | Measured | Target |
|--------|----------|--------|
| TTFB (document) | 873ms | < 200ms |
| First contentful paint (cold) | **4,636ms** | < 1,500ms |
| First API call leaves (`/v1/auth/profile`) | ~2,600ms after nav start | < 500ms |
| Route-to-content, warm SPA nav | 1.5–3s+ (varies by surface) | < 300ms |
| Slowest endpoint (`/v1/state/runs`) | **4,300–4,500ms** | < 500ms |
| Duplicate boot fetches | `auth/profile` ×2–3, org reads ×4 | 0 |

## 2. Per-surface trace (warm SPA navigation, fetch start relative to click)

| Surface | API calls after click | Notes |
|---------|----------------------|-------|
| Overview | 8 calls; first leaves at ~467ms; `catalog/doc?digest` chained at 1,063ms taking 1,040ms | Content ghosted ~3s; full catalog (`entities?limit=100`) fetched just to render health tiles |
| Catalog | `resolve-owners` 1,290ms · `catalog/docs` 732ms + cursor page 556ms | Whole-graph fetch, client-side filtering; 93 rows un-virtualized (cap 5,000) |
| Docs | full doc index via `limit=100` + cursor walk | Fetch starts ~447ms after click |
| Activities | `state/runs` **4,498ms** | Page shows skeleton the entire time; blocks on the one call |
| Events | `events` 514ms | Best-behaved surface |
| Work | summary + cycles + sessions + profiles in parallel; then `work/events/stream` ~1/s | Reconnect spin (§3.6) |
| Agents | sessions/profiles/attention at ~487ms → `routines` chained at 1,129ms | Near-blank ~3s; sequential waterfall |
| Teams | 4 calls incl. another full `entities?limit=100` | Loads fine; redundant catalog refetch |
| Git Repos | 5 parallel calls, slowest `integrations` 841ms | Content ghosted well past data arrival |
| Integrations | `agents/providers` 455ms | Ghosted ~3s regardless |
| Secrets | 2 calls, but first leaves **777ms** after click | Mount-then-fetch delay dominates |
| Entity detail | `catalog/docs?entityRef` 605ms → `catalog/doc?digest` chained, 1,268ms | ~2.5s to doc content; row click only works on the chevron |
| ⌘K palette | none | "api-edge" (an existing service) returns **zero results** |

Cross-cutting observations: identical `_rsc` prefetches fired repeatedly for
the same routes on hover (dozens over a session); board/table view switches are
instant (client-side — good); no console errors; JS heap a healthy ~11MB;
transfer sizes are small (~85KB gzip scripts) — **payload is not the problem;
sequencing is.**

## 3. Root causes (verified in code)

### 3.1 Everything renders client-side, gated twice
Every page is `"use client"` and fetches on mount
(`apps/web-console-next/src/app/(app)/orgs/[orgSlug]/*/page.tsx`). `OrgScope`
(`src/components/shell/org-scope.tsx:31,42`) blocks each page behind the org
list resolve before page queries even start. Result: fetches leave 430–780ms
after click on warm navs, and cold boot serializes
`HTML → JS → hydrate → auth → org list → page queries` → FCP 4.6s. There is no
server-side data fetching anywhere; `loading.tsx` files are static skeletons.

### 3.2 The boot chain duplicates itself
`src/components/shell/last-org-recorder.tsx:29-50` raw-calls
`client.auth.getProfile()` + `updateProfile()` outside the query cache while
`qk.profile()` is separately fetched by `sidebar-account.tsx:32` and
`workspace-overview.tsx:81`; `resolvePostAuthDestination`
(`src/lib/last-org.ts:84`) raw-calls profile + org list again. Observed:
2–3× `/v1/auth/profile`, 4× org-scoped reads in flight simultaneously on boot.

### 3.3 `/v1/state/runs` is an N+1 loop — the 4.5s stall
`apps/state-worker/src/handlers/runs.ts:694-700`: after `listOrgRuns` returns
up to 50 rows (`constants.ts:44`), the handler `await`s
`repo.getRunJobCounts(...)` **once per run, serially** — ~51 sequential
Postgres round-trips through Hyperdrive, each on a per-request connection
(`packages/db/src/hyperdrive/executor.ts:27-44`, pooling reverted → PERF9).
Same pattern in project-scoped `handleListRuns` (`runs.ts:608-612`). The
Activities surface blocks on this one call. Adjacent finding: `resolve-owners`
(`membership-worker/src/handlers/owner-handles.ts:232-234`) runs two
independent queries sequentially. Note `/state/*` has **no Server-Timing**
(state-facade lacks `withEdgeTimings`) — this stall is invisible in timing
headers today.

### 3.4 Digest-addressed doc content is neither indexed nor cached
`findCatalogDocProject` (`packages/db/src/state/repository.ts:1324-1351`) runs
a 3-way UNION where two legs are leading-wildcard `LIKE '%digest%'` scans over
`repo_facet` and `org_catalog_entities` — forced sequential scans — then an R2
GET. The response is immutable-by-digest yet sets no `cache-control`
(`state-worker/src/handlers/repo-facets.ts:266-271`). Measured 1.0–1.3s per
doc open, paid again on every revisit.

### 3.5 A 280ms entrance fade re-runs on every navigation
`Screen` (`src/components/ui/northwind.tsx:20-35`) hard-codes
`animate-fade-up` (`tailwind.config.mjs:144-147,188`), re-mounted per route —
so even cache-served content fades from `opacity: 0` on every click, and
surfaces whose queries are still resolving sit ghosted for seconds. The
animation punishes exactly the case IC3 optimizes for.

### 3.6 The SSE tail spins
`work-workbench.tsx:52-102` reconnects the `work/events/stream` SSE leg with a
1s floor. The server implements a capped streaming short-poll (2.5s DB poll,
55s max — `state-worker/src/handlers/work.ts:366-423`), but observed reconnects
arrive ~1/s, consistent with the OpenNext/Cloudflare deployment not actually
streaming the body — each leg completes immediately and the loop spins at the
floor. Each open stream also holds a DB executor polling every 2.5s.

### 3.7 ⌘K searches a static list
`command-registry.ts:78-365` builds only hard-coded navigation/create
commands; `useRegisterCommands` has **zero call sites**. No entity, doc, team,
or secret is searchable. "Find anything" cannot find `api-edge`.

### 3.8 List hygiene
Catalog table renders up to 5,000 rows with a plain `.map()`
(`components/catalog/portal/table-view.tsx`) — no virtualization. Row
navigation only via the chevron. Hover `_rsc` prefetches are not deduped.

## 4. What is already right (don't re-fix)

React Query with 30s SWR + in-flight dedupe (PERF1/PERF11) works where it's
used; keyset pagination is efficient; safe-GET rate limiting is zero-I/O
(PERF5); actor resolution is cached (PERF2); bundles are small and
`optimizePackageImports` is on; board/map/drawer are code-split; progressive
catalog paint via `onPage` exists. The gap is sequencing and the surfaces that
bypass these mechanisms.
