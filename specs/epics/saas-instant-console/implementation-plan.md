# saas-instant-console — Implementation Plan (IC0–IC9)

Ordered by impact ÷ effort. Measurement record and per-finding rationale live
in `design.md`. Every milestone re-measures its own surface before/after and
records the numbers in `IMPLEMENTATION-STATUS.md` (created at first ship).

## IC0 — Full-surface measurement record — ✅ Landed with this epic
The 2026-07-23 walkthrough: per-surface fetch traces, boot-chain timing,
root-cause analysis with file/line refs (`design.md`). Re-run after IC3 and at
epic close; the re-measurement is part of each milestone's "done when".

## IC1 — Kill the Activities stall: slow-endpoint quick wins — 🗓️ Planned
Fix the three endpoints the audit caught red-handed, smallest-diff first:
- `handleListOrgRuns` + `handleListRuns` N+1 (`runs.ts:694-700`, `608-612`):
  fold job counts into the list query (grouped aggregate or `LEFT JOIN
  LATERAL`), or at minimum `Promise.all` the counts. ~51 round-trips → 1–2.
- `resolve-owners`: `Promise.all` the two independent queries
  (`owner-handles.ts:232-234`).
- Add `withEdgeTimings` to the state-facade so `/state/*` shows up in
  `Server-Timing` (closes the observability hole that hid this stall; extends
  PERF14b).
**Done when:** `/v1/state/runs` p50 < 400ms warm (from 4.3–4.5s); Activities
route-to-content < 1s warm; `/state/*` phases visible in `Server-Timing`.
Owner: state-worker, membership-worker, packages/db, api-edge.

## IC2 — One boot, one fetch — 🗓️ Planned
Route every session-boot read through the shared query cache: replace the raw
SDK calls in `last-org-recorder.tsx` and `resolvePostAuthDestination`
(`lib/last-org.ts`) with `qk.profile()` / `qk.orgs()` cache reads (the
`updateProfile` write stays, debounced, off the critical path). Audit for any
remaining `client.*` calls mounted in the shell that bypass `useApiQuery`.
**Done when:** a cold boot issues exactly one `/v1/auth/profile` and one
`/v1/organizations` request (verified in the network trace); no org-scoped
read is issued more than once concurrently.
Owner: web-console-next.

## IC3 — Paint from cache, render before fetch — 🗓️ Planned
The structural milestone. Two legs:
- **Persist the query cache** (TanStack persister → IndexedDB, keyed by
  target+token epoch, respecting `gcTime`): revisits and warm navigations
  paint real data instantly and revalidate in background. `OrgScope` stops
  gating revisits behind a skeleton — cached org list renders immediately.
- **Start data before hydration**: hoist the boot reads (profile, org list,
  and the landing surface's first query) so they leave with the document
  rather than ~2.6s after it — either RSC-side fetch streamed into the shell,
  or an inline early-fetch primer that primes the query cache pre-hydration.
  Decision on RSC-vs-primer is D1 (see risks); the primer is the smaller diff
  and OpenNext-safe.
**Done when:** warm route-to-content < 300ms on every sidebar surface; cold
FCP < 1.5s; Secrets-style mount-then-fetch delay (777ms) eliminated.
Owner: web-console-next.

## IC4 — Perceived-speed pass — 🗓️ Planned
- `Screen`'s `animate-fade-up` runs once per cold load, not per navigation;
  cache-served paints render with no entrance animation (or ≤120ms).
- Skeleton discipline: a surface may skeleton only what it does not have —
  never ghost already-rendered content while revalidating; SWR renders stale
  data at full opacity with a subtle revalidation affordance.
- Sequential mount waterfalls flagged in the audit (Agents: sessions →
  routines) collapse to parallel queries.
**Done when:** navigating between two cached surfaces shows no blank/ghost
frame (verified by trace screenshots); Agents paints its shell < 500ms warm.
Owner: web-console-next.

## IC5 — Immutable by digest, cached like it — 🗓️ Planned
- `findCatalogDocProject`: replace the leading-wildcard `LIKE` UNION legs with
  an indexed exact-match (normalized digest column or expression index on
  `doc_ref->>'digest'`), keeping the encoding workaround only as fallback.
- Doc responses get `cache-control: public, max-age=31536000, immutable`
  (content-addressed by digest — safe by construction) + edge Cache API
  read-through on the doc GET (scoped instance of PERF8).
**Done when:** entity doc open < 300ms warm; repeat doc opens served without a
DB or R2 touch.
Owner: state-worker, packages/db, api-edge.

## IC6 — Streams that actually stream — 🗓️ Planned
Verify SSE passthrough on the OpenNext/Pages deployment (design.md §3.6). If
legs genuinely hold ~55s: keep transport, fix the client (exponential backoff
+ jitter, single shared stream per org via a broadcast channel instead of
per-surface tails). If the platform can't stream: switch the tail to the
existing DO relay's WebSocket path (AN groundwork) or honest long-polling with
`Retry-After`. Either way the ~1/s reconnect spin and per-connection 2.5s DB
poll multiplication end.
**Done when:** steady-state Work surface holds ≤1 stream connection with ≥30s
legs (or socket equivalent); reconnects back off exponentially.
Owner: web-console-next, state-worker.

## IC7 — ⌘K finds anything — 🗓️ Planned (delivers PX6)
Feed the palette from data: register catalog entities, docs, teams, and
secrets as commands sourced from the (persisted, IC3) query cache, with lazy
first-fetch when cache is cold; fuzzy match on name/ref/path; recent-entities
ranked first; entity hit navigates to the detail page. Wire the existing
`useRegisterCommands` seam rather than inventing a new one.
**Done when:** typing any existing service name (e.g. `api-edge`) surfaces its
entity < 50ms from a warm cache; palette open-to-interactive < 100ms.
Owner: web-console-next.

## IC8 — Big-list hygiene — 🗓️ Planned
- Virtualize the catalog table (plain `.map()` today, 5,000-row cap).
- Make the entire catalog row the link (today only the chevron navigates);
  prefetch entity data on row hover/intent.
- Dedupe hover `_rsc` prefetches (dozens of identical prefetches observed per
  session).
**Done when:** catalog stays 60fps scrolling at 1,000+ rows; row click
anywhere navigates; repeated hovers issue zero duplicate prefetches.
Owner: web-console-next.

## IC9 — Budgets in CI — 🗓️ Planned
Encode the epic's targets as enforced budgets: a Playwright-driven trace suite
(cold boot, warm nav across every sidebar surface, palette search) asserting
cold FCP < 1.5s, warm route-to-content < 300ms, zero duplicate boot fetches,
zero N+1 regressions (fetch-count assertions per route); wired into CI as a
required check with a small tolerance band. Real-user numbers ride the PERF6
Analytics Engine sink — one dashboard, same phase names.
**Done when:** a PR that reintroduces a duplicate boot fetch or a >300ms warm
nav fails CI; the dashboard shows p50/p95 per surface.
Owner: web-console-next, tests/, api-edge (PERF6).

## Ride-alongs (owned elsewhere, tracked here)
- Per-request Postgres connection setup → **PERF9** (do not re-attempt
  isolate-scoped reuse without the stage canary — see saas-performance risks).
- Short-TTL authz-context micro-cache (the 2-hop membership+policy tax on
  every state/work call) → **PERF13**.
- Edge response cache for safe GETs beyond IC5's doc scope → **PERF8**.
