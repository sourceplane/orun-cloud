# saas-performance — Implementation Plan (PERF1–PERF14)

The PERF task ladder, ordered by impact ÷ effort. The measurement record and
per-task *design* rationale live in `design.md`; this is the milestone list with
status + "done when". Status reflects code reality as of 2026-06-08.
PERF10–PERF14 were added by the 2026-06-08 **second full-surface audit**
(see `design.md` § "Second full-surface audit").

## PERF1 — Console client cache, SWR & prefetch — ✅ Shipped (PR #216, Task 0130)
Client query cache (`@tanstack/react-query`-style) with stale-while-revalidate;
cached data renders instantly on navigation and revalidates in background; in-flight
dedupe; org list cached so `OrgScope` stops refetching per page; prefetch on
hover/intent; auth gate moved so the shell paints from cache. Frontend-only.
Owner: web-console-next.

## PERF2 — Edge bearer-resolution cache — ✅ Shipped (PR #220, Task 0131)
Cache the bearer→actor resolution at api-edge (built-in Cache API `caches.default`,
keyed by token hash, short TTL, invalidated on logout) so the identity-worker hop +
its 2 DB queries are skipped on the hot path. Owner: api-edge (+ identity-worker
logout invalidation).

## PERF3 — DB connection reuse & query efficiency — ✅ Shipped (PR #221, Task 0132)
Parallelized `getBillingSummary`; fixed the member-list N+1 with a batched role
query; added the missing membership/subject index. Owner: `packages/db` + handlers.
**Reverted leg:** module-scoped connection reuse (Task 0134, #224/#225) was rolled
back (#227) — the Workers runtime forbids reusing a socket opened in another
request. A later scalar IN-list fix (#228) repaired a batched-lookup bind bug. The
reverse-lookup index migration + Hyperdrive cache audit are folded into **PERF9**.
**Do not re-attempt isolate-scoped reuse without a stage canary** (see risks).

## PERF4 — Hot-path hop reduction, parallelization & latency observability — ✅ Shipped (PR #230, Task 0133)
Collapsed/parallelized the authorization fan-out on hot reads (authorization-context
fetch runs concurrently with the resource read via `Promise.all`, policy applied
after, speculatively-read data discarded on deny — deny-by-default preserved +
tested). Shipped the dependency-free `@saas/contracts/timing` helper; each worker
emits `Server-Timing` (`authctx`/`db`/`policy`/`total`, +`enrich` for members) and
api-edge appends `edge_auth`/`edge_downstream`/`edge_total`. **Blind spot found
2026-06-08:** timing starts inside `replayOrExecute`, so the ~264ms rate-limiter
gate is in none of the phases — PERF6 closes this.

## PERF5 — Take the rate limiter off the KV read-modify-write hot path — ✅ Shipped + verified (PRs #245/#246/#247)
`enforceRateLimit` ran a KV `get`+`put` per bucket on every request, before auth,
org+identity serialized → ~264ms on every org-scoped read. **Stage A (#245):** safe
reads use a zero-I/O in-isolate limiter; write buckets parallelized. **Stage B
(#246):** durable write counters moved to a `RateLimiterDO` Durable Object — atomic,
no KV write on the hot path. **Verified live (#247):** org-scoped reads ~320ms →
~55ms, writes ~320ms → ~65ms (edge floor; beats the <150ms target). Fail-open + KV
fallback preserved.

## PERF6 — Whole-request observability + p50/p95 dashboards — 🛠️ In progress
Extend the timing helper to cover `enforceRateLimit` + idempotency (emit
`edge_ratelimit` / `edge_idem`) so the full request is measurable, then sink
`Server-Timing` to Analytics Engine for per-route dashboards (absorbs the PERF4
follow-up); add a synthetic prober for the isolation probes. Owner: api-edge +
contracts/timing + Analytics Engine.
**Landed:** edge-gate measurability in `Server-Timing` (#248). **Remaining:** AE
sink + per-route dashboards + synthetic prober.

## PERF7 — Cold-start reduction (edge + console SSR) — 🗓️ Planned
Re-measured 2026-06-08: edge cold ~0.7s worst-case; **console SSR spikes
1.0–2.6s including mid-sequence isolate churn** (HTML is `no-store`, every visit
pays SSR). Shrink bundles + lazy-load rare-path deps; evaluate Smart Placement
and a keep-warm cron; consider static/ISR shell for the console (human decision
D4 — see risks). Owner: all workers + web-console-next.

## PERF8 — Edge response cache for safe GETs — 🗓️ Planned
Cache authorizable safe GETs at the edge (Cache API / `s-maxage` + SWR), keyed by
actor+scope+route, invalidated on mutation; pairs with PERF1. Owner: api-edge.

## PERF9 — At-scale DB + deferred PERF3 leftovers — 🗓️ Planned
Ship the reverse-lookup index migration and the Hyperdrive cache-eligibility audit
deferred from PERF3; add a Supabase read replica + Hyperdrive read routing when
traffic warrants. Owner: `packages/db` + infra.

## PERF10 — Console asset delivery: immutable caching + bundle trim — 🗓️ Planned
Add a `_headers` file to the Workers Assets output so hashed `/_next/static/*`
chunks are `public, max-age=31536000, immutable` (today: `max-age=0,
must-revalidate` → ~19 revalidations per repeat visit); trim the 39 KiB polyfills
chunk via browserslist; review the two largest chunks. Done when repeat visits
issue zero asset revalidations and entry JS < ~170 KiB gzip. Owner:
web-console-next.

## PERF11 — Console client-cache completion (shell + profile) — ✅ Shipped (PR pending)
Moved the three highest-traffic non-paginated manual-fetch spots onto
`useApiQuery` shared cache keys: sidebar org switcher (was firing a duplicate
org-list fetch every shell mount), scope switcher (was 3 uncached org→project→env
calls/mount), and account/profile (was an uncached `useEffect`). These reuse the
page query caches so the shell paints from cache and dedupes in-flight requests;
profile save writes back to the cache via `setQueryData`. Owner: web-console-next.

## PERF11b — Console client-cache: paginated surfaces — 🗓️ Planned
The three cursor-paginated surfaces deferred from PERF11 (each needs first-page
caching kept compatible with "load more" accumulation): account/security,
usage (summary + violations), webhook delivery history. Done when the first
page paints from cache on revisit while pagination beyond it still works.
Owner: web-console-next.

## PERF12 — Server read-path parallelization completion + identity JOIN — 🗓️ Planned
Apply the PERF4 authctx∥db pattern to the 10 remaining serial read handlers
(billing plans/entitlements/invoices/customer; config settings/flags/secrets;
webhooks endpoints + delivery-attempts list/get; ~80–100ms each), and fold the
identity resolve's 2 serial DB queries into single JOINs. Deny-by-default
discard semantics preserved + tested, exactly as PERF4. Owner: worker handlers +
identity repo.

## PERF13 — Hot-fact micro-caching (authz context + near-static reads) — 🗓️ Planned
Short-TTL (10–30s) cache for membership `authorization-context` (highest ROI —
consumed by 6+ workers per authed request); 24h/event-invalidated plans-catalog
cache; 5–10m write-invalidated caches for config settings/flags + webhook
endpoint lists. Cuts latency and Supabase load. Revocation latency bounded by
TTL (document like PERF2). Owner: membership/billing/config/webhooks workers.

## PERF14 — Logging cost guard (timing-log sampling) — ✅ Shipped (edge)
`shouldEmitTimingLog` (in `@saas/contracts/timing`) samples the structured timing
`console.log` lines (default 1-in-10 + always-log-slow ≥1s) so Workers Logs
ingestion stays within the included tier (~$50–80/mo exposure at 50M req/mo
otherwise). The `Server-Timing` *header* stays unsampled (free). Wired into the
api-edge emit sites (`withEdgeTimings`, `finishGate`). Owner: api-edge + contracts.

## PERF14b — Server-Timing coverage for uninstrumented handlers — 🔄 In progress
Slice 1 ✅ (PR #320): `shouldEmitTimingLog` sampling applied at the 4 existing
worker `withTimings` sites (billing/events/membership/projects). Slice 2 ✅:
config-worker list handlers (settings/flags/secrets) instrumented with
`authz_ctx`∥`db` + `policy` + `total` phases — makes the PERF12b overlap
directly visible — with a sampled `withTimings`. Slice 3 ✅: webhooks-worker
PERF12c read handlers (endpoints list, delivery-attempts list/get) with
`authz`∥`db` + `total`. Slice 4 ✅: identity-worker hot resolve paths
(resolve-bearer — every edge bearer-cache miss, the PERF12d JOIN — plus
session and profile GET) with `resolve` + `total`. Remaining: metering (0/6),
notifications (0/6), integrations (0/3), billing's other reads, and the
login/oauth flows. Feeds PERF6b dashboards. Owner: all workers.
