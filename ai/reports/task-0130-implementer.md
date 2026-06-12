# Task 0130 — PERF1: Console client cache, SWR & prefetch — Implementer Report

Milestone `PERF1-console-client-cache`. Branch
`impl/task-0130-console-client-cache`. Frontend-only; no backend/contract change.

## What shipped

- **Query cache** — added `@tanstack/react-query` v5 with a single app-lifetime
  `QueryClient` in `src/app/providers.tsx` (staleTime 30s, gcTime 5m,
  `refetchOnWindowFocus: false`, retry 1). A `CacheResetOnAuthChange` clears the
  cache on token change (login/logout) so a new identity never reads the old
  one's data.
- **`useApiQuery(key, fn)`** (`src/lib/query.ts`) — cache-backed replacement for
  the bespoke `useAsync`, keeping the same `{data, loading, error, reload}`
  surface. `loading` maps to react-query `isLoading` (true only on first fetch
  with no cached data), so a cached navigation paints immediately with a
  background revalidation; in-flight requests dedupe automatically.
- **Stable keys** — `src/lib/query-keys.ts` (`qk`, dependency-free/testable):
  one factory per resource, scoped by id, collision-free across resources.
- **Migrated all cacheable reads** off `useAsync` → `useApiQuery` with proper
  keys: orgs, projects, environments, members, invitations, api-keys, webhooks
  (list + detail), billing summary/entitlements/invoices, and the env-detail
  page. `useAsync` is retained only for the webhook delivery-history `initial`
  fetch (a cursor-accumulator with a side effect that must run per mount).
- **Org list cached** — `useOrgBySlug`/`OrgScope` now read the single shared
  `qk.orgs()` query; per-org pages no longer refetch the full org list on every
  navigation.
- **Prefetch on intent** — `usePrefetch()` + `onMouseEnter` on org cards
  (prefetch that org's projects) and project cards (prefetch that project's
  environments).
- **Auth-gate paint** — `(app)/layout.tsx` now renders the app frame
  (sidebar/topbar rails) immediately instead of a full-screen blank; data
  components + children mount only once the session token has hydrated
  (`useRequireAuth` still redirects to /login when there's genuinely no token).
- **Optimistic mutations via cache** — project/environment archive now mutate
  the query cache (`setQueryData` optimistic remove + rollback on error),
  removing the local list-mirror state; the cache is the single source of truth.

## Tests & gates

- `tests/web-console-next/src/query-keys.test.ts` (stability, scope isolation,
  cross-resource collision-free, resource tags). Full suite **140 passing**.
- typecheck ✓, lint ✓, `next build` ✓. Bundle delta: First Load JS shared 100kB
  (≈unchanged); react-query adds ~20–27kB to data routes (e.g. projects
  171→198kB) — justified by the perceived-speed win.

## Verification (Playwright vs live stage, real token)

- Navigating **5 org-scoped pages** (projects→members→audit→billing→projects)
  added **zero** `/v1/organizations` refetches — OrgScope serves the org list
  from cache.
- Revisiting Projects **painted from cache instantly with no skeleton flash**.
- Hovering a project card **prefetched** its environments (0→1 request before
  click).
- **Zero console errors.**
- Note: in `next dev` with React StrictMode the initial mount double-invokes
  queries (the first `/orgs` load showed 3 org-list fetches); this is a dev-only
  artifact — production renders once. The decisive signal is that subsequent
  navigation added none.

## Notes / follow-ups

- This task changes *how often* the client pays server latency and how it
  paints; the raw server TTFB is unchanged (owned by PERF2/0131 and PERF3/0132).
- The webhook delivery-history list still refetches on mount (intentional — it's
  a paginated accumulator); could move to an infinite-query later.
