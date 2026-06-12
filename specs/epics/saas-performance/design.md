# Performance Epic — Server-Side Latency (design)

Status: Normative direction. This is the **design doc** of the `saas-performance`
epic (start at [`README.md`](./README.md); milestones in
[`implementation-plan.md`](./implementation-plan.md); as-built in
[`IMPLEMENTATION-STATUS.md`](./IMPLEMENTATION-STATUS.md)). It owns the measurement
record, the root-cause analysis, and the per-task design rationale. The roadmap
([`../../roadmap.md`](../../roadmap.md)) keeps only the one-line PERF index.
Sequencing remains the Orchestrator's call.

Last re-measured: **2026-06-08** (live stage + prod, warm, no cold start unless
noted). Supersedes the stale 2026-06-02 baseline embedded in the roadmap.

## Purpose

Make authenticated reads feel instant. The original PERF cluster (PERF1–PERF4)
was scoped against a 2026-06-02 baseline that blamed three things: per-request DB
connection setup, uncached bearer resolution, and serial multi-hop fan-out. Those
have all shipped — and a fresh end-to-end measurement shows the latency budget
has **moved**. The dominant remaining cost is no longer the database or the auth
fan-out; it is the **edge rate limiter doing a Workers-KV read-modify-write on
every request, before authentication, twice for org-scoped routes**. This epic
records that finding and schedules the work to fix it, plus the remaining
cold-start and observability gaps.

End-state target: **p50 authed read < 150ms server-side** (warm), the console
instant on navigation, and every hot-path phase measurable in prod.

## How this was measured (2026-06-08)

Black-box TTFB against the live workers, no privileged access:

- Edge: `https://api-edge-{stage,prod}.rahulvarghesepullely.workers.dev`
- Console: `https://{stage,prod}.sourceplane.ai`
- `curl -w '%{time_starttransfer}'`, 12 warm samples per probe (first discarded as
  cold), p50 reported. Network/TLS to the nearest colo is ~40–50ms and is included
  in every number below.

Probes were chosen to **isolate one cost at a time** by exploiting which code
paths each route does and does not execute:

- **OPTIONS preflight** returns from `handlePreflight` *before* routing and before
  `replayOrExecute` → pure warm edge floor, **no rate limiter**.
- **`/health`** is handled inline in `index.ts` and **bypasses the rate limiter**,
  but does a real Hyperdrive DB ping → isolates the DB round-trip.
- **`GET /v1/organizations`** has no `:orgId` path segment → the limiter evaluates
  **one** bucket (identity) → one KV get+put.
- **`GET /v1/organizations/:org/...`** → the limiter evaluates **two** buckets
  (org + identity) **sequentially** → two KV get+put round-trips.
- All authed reads short-circuit at `resolveActor` for a missing/invalid token, so
  a no-token probe still pays the full rate-limiter cost that runs *before* it.

## Live measurements (prod, warm p50 TTFB)

| Probe | p50 | What it isolates |
| --- | --- | --- |
| `OPTIONS /v1/organizations` (preflight) | **56ms** | true warm edge floor (no rate limiter) |
| `GET /v1/zzz` → 404 | 56ms | routed edge floor (no rate limiter) |
| `GET /health` (Hyperdrive DB ping) | **62ms** | full DB round-trip, **no rate limiter** |
| `GET /v1/organizations` (1 RL bucket) | **190ms** | floor + **1× KV get+put** |
| `GET /v1/organizations/:org/projects` (2 RL buckets) | **320ms** | floor + **2× KV get+put**, sequential |
| `GET /v1/organizations/:org/billing/summary` (2 RL buckets) | 332ms | floor + 2× KV get+put |
| `GET /v1/auth/profile` bad-token | 225ms | floor + 1 bucket + identity-worker hop |

Stage tracks prod within noise. Cold isolates (first hit after idle) add **0.9–1.6s**
at the edge and **1.4–1.8s** for console SSR; warm console SSR is ~120–160ms.

Derived costs:

- **Edge floor (warm): ~56ms.**
- **DB round-trip via Hyperdrive: +6ms** over floor → the DB is *no longer a
  problem*. Hyperdrive's connection pool absorbs the handshake even though each
  worker still creates and disposes a `postgres` client per request.
- **Each rate-limit bucket: ~130ms**, and the two buckets are evaluated in a
  serial `for` loop → an org-scoped read spends **~264ms in the rate limiter
  before the actor is resolved and before any data is read.** That is ~80% of the
  warm server time on a hot read.
- **Identity-worker hop (uncached bearer): ~35ms** — cheap; the PERF2 cache makes
  the warm-hit case ~0ms.

## Root-cause analysis

### 1. The rate limiter is the #1 hot-path cost (new finding, undocumented)

`apps/api-edge/src/rate-limit.ts` implements a token-bucket limiter whose state
lives in Workers KV. `enforceRateLimit` runs *first* inside `replayOrExecute`
(`idempotency.ts:163`), which wraps **every** facade route — reads included, and
**before** `resolveActor`. For each bucket it calls `consumeToken`, which does a
`kv.get` followed by a `kv.put` (read-modify-write) on **every request**.

Why this is slow and structural — not a cold-cache artifact:

- **KV writes are not colo-local.** A `kv.put` propagates to KV's central store;
  it is not a free edge cache write. Measured ~130ms per bucket, stable under
  rapid fire on a single hot key (no warm-up improvement), because every request
  writes.
- **The read-modify-write defeats KV's edge read cache.** A `kv.get` immediately
  after a `kv.put` to the same key cannot be served from the colo read cache, so
  the get pays a cross-region read too.
- **The two buckets are sequential.** `enforceRateLimit` loops
  `for (const b of buckets) await consumeToken(...)`, so org + identity buckets
  serialize → ~2× the cost on every org-scoped route (which is most of them).
- **It runs before auth.** Even a request that will 401 pays the full KV tax.
- **Wrong primitive.** KV is a read-optimized, eventually-consistent store; it is
  the wrong backend for a per-request mutable counter. The code itself documents
  "last-writer-wins under concurrent retry" — i.e. the limit is also *inaccurate*
  under the exact load it exists to bound, in addition to being slow.

This is the single biggest lever available today.

### 2. The DB path is solved — by Hyperdrive, not by connection reuse

`/health` does a real DB ping in 62ms (p50). The 2026-06-02 baseline measured
DB-touching reads at 1–3s and blamed per-request `postgres()` create + `sql.end()`.
That tax is gone in practice because **Hyperdrive pools the upstream connection**;
the per-request client connects to Hyperdrive's local socket, not the origin.

Note the correction to the roadmap: **module-scoped connection reuse (Task 0134)
was reverted** (PR #227). The Workers runtime rejects reusing a socket opened in
one request from another ("Cannot perform I/O on behalf of a different request"),
and the self-heal retry did not reliably recover; it broke membership/billing on
stage. The current `createSqlExecutor` is intentionally per-request
(`packages/db/src/hyperdrive/executor.ts:27`). **Do not retry isolate-scoped reuse
without a stage canary — and it is no longer necessary**, because Hyperdrive
already carries the win.

### 3. The bearer cache (PERF2) does not cover `/v1/auth/*`

`resolveActor` caches successful bearer→actor resolutions in the Cache API
(`actor-cache.ts`), which is colo-local and fast — but only the org/project/
billing/audit/membership facades call `resolveActor`. The **auth facade forwards
`/v1/auth/profile` (and friends) straight to identity-worker** and never consults
the edge cache, so every profile read pays the identity hop. Low impact today
(~35ms) but worth closing once the rate limiter is fixed.

### 4. Cold starts add 1–2s

First hit to a cold isolate is ~0.9–1.6s at the edge and ~1.4–1.8s for console
SSR. With low/bursty traffic, a meaningful share of real user requests hit a cold
isolate. This is invisible in warm p50 but dominates p99 and "first click feels
slow" complaints.

### 5. PERF4 `Server-Timing` has a blind spot exactly where the cost is

PERF4 (Task 0133) instruments each facade with `createTimings()` — but the timing
block starts *inside* the `replayOrExecute` thunk, **after** `enforceRateLimit`
has already run. So the ~264ms rate-limiter cost is in **none** of the
`edge_auth` / `edge_downstream` / `edge_total` phases. The "prod latency is now
measurable" claim is true only for the part of the request that was already cheap.

## Status ledger

### ✅ Completed

| Task | Scope | Status |
| --- | --- | --- |
| **PERF1** (0130) | Console client cache (TanStack Query), SWR, prefetch | Shipped — PR #216 |
| **PERF2** (0131) | Edge bearer→actor cache (Cache API, token-hash key, 30s TTL, logout-evict) | Shipped — PR #220 |
| **PERF3** (0132) | Parallel `getBillingSummary`, member-list N+1 fix, query efficiency | Shipped — PR #221 |
| **PERF4** (0133) | Parallelize authorize∥read on hot reads; `Server-Timing` + structured timing | Shipped — PR #230 |
| **PERF5 Stage A** | Reads → in-isolate limiter (zero I/O); write buckets parallelized | Shipped & verified — PR #245 |
| **PERF5 Stage B** | Durable-object write counters (atomic, no KV write on the hot path) | Shipped & verified — PR #246 |
| **PERF6 (core)** | Edge gate (`edge_ratelimit`/`edge_idem`) in `Server-Timing` + structured log | Shipped & verified — PR #248 |

The roadmap should be read as: **PERF1–PERF5 all shipped, plus the PERF6 core.**
Only PERF4 originally carried a ✅; the rest were mislabelled/scheduled — corrected
here. PERF6's remaining half (Analytics Engine dataset + dashboards) is **PERF6b**.

#### PERF5 — rate limiter off the KV hot path → Durable Objects ✅

The edge token-bucket limiter ran on **every** request before auth and did a
Workers-KV `get`+`put` per bucket, with the org+identity buckets evaluated
serially → **~264ms on every org-scoped read** (~80% of warm server time) and
the documented "last-writer-wins" inaccuracy on writes. Shipped in two stages:

- **Stage A (PR #245)** — safe (read) methods use a colo-local, zero-I/O
  in-isolate token bucket; unsafe (write) buckets are evaluated concurrently
  (`Promise.all`). Reads leave the KV path entirely.
- **Stage B (PR #246)** — the durable write counters move from KV to a
  `RateLimiterDO` Durable Object (one instance per `(scope,key)` bucket). The
  DO's single-threaded execution makes the consume **atomic** (fixing the race)
  with no central KV write on the hot path. `enforceRateLimit` prefers the DO,
  falls back to the Stage A KV limiter when the binding is absent (dev/local),
  then to fail-open. First Durable Object in the repo; `v1` sqlite migration on
  local/dev/stage/prod, validated with `wrangler --dry-run` on every env.

**Verified live (prod, warm p50 TTFB):**

| Path | Original | Stage A | Stage B |
| --- | --- | --- | --- |
| `GET …/projects` (read) | 320ms | 58ms | **56ms** |
| `GET …/billing/summary` (read) | 332ms | 62ms | **53ms** |
| `POST …/projects` (write) | ~320ms | 221ms | **65ms** |

Org-scoped reads dropped **~5.5×** and writes **~5×**; both now sit near the
~55ms edge floor. The DO-backed write returns correct, decrementing
`X-RateLimit-*` counters, confirming the limiter is both faster and race-free.
The epic SLO (org read p50 < 150ms) is beaten ~3× and writes now meet it too.

#### PERF6 (core) — the edge gate is now measurable ✅

PERF4 instrumented the facades, but its `createTimings` block starts *inside* the
`replayOrExecute` thunk — after the gate has run (root cause #5). **PR #248** times
the gate and appends `edge_ratelimit` (always) + `edge_idem` (idempotency KV
lookup) to the response `Server-Timing` (without clobbering downstream phases),
plus a structured `msg:"timing"` gate log. Verified live (prod) — and it
immediately surfaced cost structure that was previously invisible:

| Path | Observed | Reading |
| --- | --- | --- |
| GET (read) | `edge_ratelimit;dur=0` | in-isolate read limiter is **literally 0ms** — Stage A proven |
| POST, warm bucket | `edge_ratelimit;dur=10–12` | two DO checks in parallel ≈ **~11ms** (vs ~260ms KV) |
| POST, cold/far bucket | `edge_ratelimit;dur=300–360` | **DO cold/cross-colo tail** on the first write to an idle bucket |
| idempotent POST | `edge_idem;dur=40–96` | the idempotency replay **KV lookup** is a real ~40–90ms cost |

Newly-logged findings: the **DO cold/cross-colo tail (~300–360ms)** on the first
write to an idle `(scope,key)` bucket — writes are infrequent and a busy bucket
stays warm (~11ms), so it's a write-p99 tail (weigh `locationHint` later, still
open); and the **idempotency-KV `get` (~40–90ms)** — **addressed (PR #256):** a
colo-local **Cache API L1** now sits in front of KV, so same-colo replays drop to
**~3–4ms** (verified live) while KV stays the global source of truth (cross-colo
retries / L1 evictions fall through to KV — correctness unchanged). It is a
*replay* latency win only; KV writes are unchanged by design. The remaining PERF6
half (AE dataset + dashboards) is tracked as **PERF6b** below.

### ⛔ Deferred / abandoned

- **Module-scoped DB connection reuse (Task 0134) — abandoned (reverted, PR #227).**
  Runtime-incompatible (cross-request socket reuse is forbidden) and made
  unnecessary by Hyperdrive pooling. Do not re-attempt without a stage canary and
  a measured reason.
- **Reverse-lookup index migration** (`organization_members (subject_id, …)` /
  role-assignment subject index) — split out of PERF3, never shipped. Still open;
  folded into **PERF9**.
- **Hyperdrive cache-eligibility audit** (verify reads are non-transactional +
  parameterized so Hyperdrive query caching engages) — split out of PERF3, never
  shipped. Folded into **PERF9**.
- **Analytics Engine p50/p95 dashboards** — named as a PERF4 follow-up; the PERF6
  core (PR #248) now emits the metrics, so this is the consumption half → **PERF6b**.

### 🗓️ Scheduled (new)

Ordered by impact ÷ effort. With PERF5 and the PERF6 core shipped, the next
headline is **PERF7 (cold starts)** — now the largest remaining latency — with
**PERF6b** (dashboards) as the cheap observability follow-on. The 2026-06-08
**second full-surface audit** (section below) added **PERF10–PERF14**; of those,
**PERF10 (immutable assets) and PERF11 (client-cache completion)** are the
cheapest perceived-snappiness wins and can land before PERF7's heavier legs.

#### PERF6b — Aggregate the Server-Timing metrics into dashboards

The PERF6 **core shipped** (PR #248): every edge response now carries
`edge_ratelimit`/`edge_idem` and emits a structured `msg:"timing"` line. The
**consumption** half remains (not probe-verifiable, hence split out): wire the
structured line into an **Analytics Engine** dataset (created on first
`writeDataPoint`, no pre-provisioning) and stand up per-route **p50/p95
dashboards** (folds in the PERF4 follow-up); add a synthetic prober (cron) hitting
the isolation probes so the floor / DB / rate-limit / hop costs are trended.

**Owner:** `apps/api-edge` + Analytics Engine. **Acceptance:** dashboards show
per-route p50/p95 for `edge_ratelimit` / `edge_idem` / total. **New resource:** an
Analytics Engine dataset binding (see Cost notes).

#### PERF7 — Cold-start reduction (edge + console SSR)

**Problem:** cold isolates dominate p99. Re-measured 2026-06-08 (second audit):
edge cold improved to ~0.7s worst-case, but **console SSR spikes 1.0–2.6s** —
including *mid-sequence* (isolate churn, not just first hit) — and the HTML is
`no-store`, so every visit pays a full SSR render.

**Plan:**
- Measure per-worker bundle size and cold-eval time; lazy-load heavy/rare-path
  deps (e.g. base64/crypto helpers, provider adapters) so the hot path's eval
  cost is minimal.
- Evaluate **Smart Placement** for the DB-touching workers and a low-frequency
  **keep-warm cron** (or min-instances if/when available) for the edge and console
  to keep at least one isolate hot in the primary colos.
- For console SSR, trim the server bundle and confirm static shell is served from
  cache so first paint does not wait on a cold render.

**Owner:** all workers + `web-console-next`. **Acceptance:** cold-start p95 for the
edge under ~600ms; console cold TTFB under ~800ms.

#### PERF8 — Edge response cache for safe GETs

**Plan:** cache safe, authorizable GETs at the edge (Cache API / `s-maxage` +
`stale-while-revalidate`), keyed by actor + scope + route with a short TTL, and
invalidate on the corresponding mutation. Pairs with PERF1 (client SWR) so a
navigation can be served entirely from cache and revalidated in the background.
This is the "Cloudflare Cache API / Tiered Cache" item from the roadmap's
suggested-resources list, now scoped. **Owner:** `apps/api-edge`. **Out:**
per-user private data that cannot be safely shared across the colo cache (keep
those client-cache-only via PERF1).

#### PERF9 — At-scale DB + the deferred PERF3 leftovers

**Plan (lower priority until traffic warrants):**
- Ship the **reverse-lookup index migration** deferred from PERF3 (own migration
  PR with manifest/checksum entry).
- Complete the **Hyperdrive cache-eligibility audit** (reads non-transactional +
  parameterized).
- When read traffic warrants it, add a **Supabase read replica + Hyperdrive read
  routing** to offload reads from the primary.

**Owner:** `packages/db` + infra. **Acceptance:** index present and used by the
membership reverse lookup; Hyperdrive query-cache hit-rate confirmed; replica
routing behind a flag.

#### PERF10 — Console asset delivery: immutable caching + bundle trim

From the second audit: hashed `/_next/static/*` chunks ship with
`max-age=0, must-revalidate` (Workers Assets default — no `_headers` file), so
every repeat visit re-validates ~19 chunks; and the 202 KiB entry bundle carries
a 39 KiB polyfills chunk that modern browsers don't need.
**Plan:** add a `_headers` file to the assets output (`/_next/static/*` →
`public, max-age=31536000, immutable`; sensible TTLs for manifest/icons); tune
browserslist to drop legacy polyfills; review the two largest chunks for
lazy-loadable weight. **Owner:** web-console-next. **Acceptance:** repeat-visit
loads issue zero asset revalidations; entry JS < ~170 KiB gzip.

#### PERF11 — Console client-cache completion (kill the last manual fetches)

Six confirmed spots bypass react-query (audit list above): sidebar org switcher
(duplicate org-list fetches), scope switcher (3 uncached calls per topbar mount),
account/profile, account/security, usage page, webhook delivery history.
**Plan:** move all six onto `useApiQuery` with shared query keys so navigation
renders instantly from cache and in-flight requests dedupe. **Owner:**
web-console-next. **Acceptance:** no `useEffect`/`useAsync` data fetches remain
in the app shell or listed pages; revisits paint from cache with background
revalidate.

#### PERF12 — Server read-path parallelization completion + identity JOIN

Apply the PERF4 authctx∥db pattern to the 10 remaining serial read handlers
(billing plans/entitlements/invoices/customer; config settings/flags/secrets;
webhooks endpoints+delivery-attempts list/get) — ~80–100ms each; fold the
identity resolve 2-serial-query path (session→user, key→principal) into single
JOINs. Deny-by-default discard semantics exactly as PERF4. **Owner:** worker
handlers + identity repo. **Acceptance:** no read handler awaits authz before an
independent DB read; resolve does 1 query per token type.

#### PERF13 — Hot-fact micro-caching (authz context + near-static reads)

Highest-ROI server cache from the audit: short-TTL (10–30s) cache for membership
`authorization-context` (1 query, consumed by 6+ workers on every authed
request); 24h/event-invalidated cache for the plans catalog; 5–10m
write-invalidated caches for config settings/flags and webhook endpoint lists.
Cuts both latency **and Supabase load** (the dominant bill). Revocation latency
bounded by TTL — document the tradeoff like PERF2. **Owner:** membership/billing/
config/webhooks workers. **Acceptance:** authz-context cache hit-rate visible in
timing logs; plans/config/webhook reads serve from cache between writes.

#### PERF14 — Observability coverage + logging cost guard

Extend `Server-Timing` phases to the ~20 uninstrumented handlers (billing reads,
config, webhooks, identity resolve, metering) using the existing
`createTimings()` pattern, and add a **sampling guard** for the structured
timing `console.log` lines (1-in-N + always-log-slow) so Workers Logs ingestion
stays in the free tier (~$50–80/mo exposure at 50M req/mo otherwise). Keep the
`Server-Timing` header itself unsampled (free). Feeds PERF6b dashboards.
**Owner:** all workers + api-edge. **Acceptance:** every read handler emits
phases; timing-log volume ≤ included tier at projected traffic.

## Second full-surface audit (2026-06-08, post-PERF5/PERF6)

A per-section sweep of the live product (stage + prod probes on every edge route
family + console delivery) cross-checked with a full client and worker code
audit. Goal: "world-class snappy" + cost-effective. Scheduled as **PERF10–PERF14**
below.

### Live numbers (this pass)

- **Edge: uniformly at floor.** Every route family (auth/org/project/audit/
  billing/webhooks) probes ~50–65ms p50 on both stage and prod with
  `edge_ratelimit;dur=0`; a real cross-worker hop (`GET /v1/auth/oauth/providers`
  through identity-worker) is ~52–56ms ≈ floor — **service-binding hops are
  essentially free**. Edge cold has improved to ~0.7s worst-case.
- **Console: warm SSR 60–120ms, but cold/isolate-churn spikes 1.0–2.6s** (prod
  showed a 2.58s spike mid-sequence — not just first-hit). HTML is
  `private, no-cache, no-store`, so every visit pays a full SSR render.
- **Static-asset caching bug (high-leverage, one-file fix):** hashed
  `/_next/static/*` chunks are served `cache-control: public, max-age=0,
  must-revalidate` (Workers Assets default; no `_headers` file in
  `.open-next/assets`). The browser re-validates ~19 chunks on **every repeat
  visit** instead of caching immutably (`max-age=31536000, immutable`).
- **Bundle: 202 KiB gzip** total JS on the entry page; largest chunks 52.5K +
  45.6K (framework) and **polyfills 39.4 KiB** — mostly dead weight on modern
  browsers (browserslist tuning).

### Client audit (confirmed in code; the #234 salvage, verified)

Several #234/M5 claims are already fixed (env-page waterfall, hover prefetch,
auth-hydration flash, org-scope caching — all ✓). Still real:

1. `sidebar-org-switcher.tsx:33` fetches the org list **outside react-query** →
   duplicate in-flight org-list requests on every shell mount.
2. `scope-switcher.tsx:43–69` makes **3 manual uncached calls** (orgs → projects
   → envs) on every topbar mount instead of reusing the page query cache.
3. `account/page.tsx:34` (profile), 4. `account/security/page.tsx:40`,
   5. `usage/page.tsx:86,262`, 6. webhook delivery history
   (`settings/webhooks/[endpointId]/page.tsx:305`) — all manual
   `useEffect`/`useAsync` fetches that bypass the query cache → spinners on
   every revisit instead of instant cached render.

### Server audit (worker read paths)

- **10 read handlers still run authz serially before the DB read** (the PERF4
  authctx∥db pattern was only applied to the 4 hot reads): billing
  `list-plans` / `list-entitlements` / `list-invoices` / `get-customer`; config
  `list-settings` / `list-feature-flags` / `list-secrets`; webhooks endpoints
  list/get + delivery-attempts list/get. ~80–100ms each when authed.
- **identity resolve does 2 serial DB queries** (session→user; api-key→principal)
  on every bearer-cache miss — foldable into one JOIN
  (`identity-worker/src/services/auth.ts:171`).
- **Highest-ROI cache:** membership `authorization-context` (1 query, consumed by
  6+ workers on every authed request) — short-TTL (10–30s) cache.
- **Near-static data uncached:** plans catalog (changes ~never → 24h/event-driven
  cache), config settings/flags (10m, invalidate on write), webhook endpoints
  (5m). Each saves a Supabase query per read → also a **Supabase compute** saver.
- **Server-Timing coverage gaps:** ~20 handlers (all billing reads, config,
  webhooks, identity resolve, metering) emit no phase breakdown — only the 4
  PERF4 hot reads do.
- Already optimal (no action): the 4 PERF4 hot reads, members enrich (batched),
  check-entitlement shared executor.

### Cost-effectiveness notes from this pass

- **Structured timing logs:** every request now emits 2–3 JSON `console.log`
  lines (gate + edge facade + worker). If Workers Logs ingestion is enabled,
  that's ~100–150M lines @ 50M req/mo ≈ **$50–80/mo** ($0.60/M beyond 20M).
  Guard: sample timing logs (e.g. 1-in-10) and/or log only slow requests;
  keep the `Server-Timing` *header* unsampled (free).
- The near-static caches above cut Supabase queries — the **dominant bill** —
  and the immutable-assets fix removes ~19 revalidation round-trips per repeat
  visit (free, pure UX).
- PERF6b AE sink should sample (1-in-N) if volume makes $0.25/M material.

## Target SLOs (warm, server-side p50 unless noted)

| Surface | Pre-PERF5 | Now (post-PERF5) | Target |
| --- | --- | --- | --- |
| Edge floor | 56ms | 56ms | ≤ 60ms |
| DB round-trip (Hyperdrive) | 62ms | 62ms | ≤ 70ms |
| Org-scoped authed read (rate-limit portion) | ~264ms | **~0ms** ✅ | — |
| Org-scoped read (no-token probe, end-to-end) | ~320ms | **~55ms** ✅ | **< 150ms** |
| Org-scoped write (no-token probe, end-to-end) | ~320ms | **~65ms** ✅ | < 150ms |
| Edge cold-start p95 | ~0.9–1.6s | ~0.9–1.6s | ≤ 600ms (PERF7) |
| Console SSR cold TTFB | ~1.4–1.8s | ~1.4–1.8s | ≤ 800ms (PERF7) |

## Cost notes (Cloudflare)

Estimates against Cloudflare **Workers Paid (Standard)** published prices
(2026-06) — verify against the bill. This stack **requires** the Paid plan
($5/mo): Durable Objects and Hyperdrive are not on the Free plan, so the Free
plan's 100k req/day is not an option here.

**Key billing fact:** on the Standard plan, **service-binding subrequests are NOT
billed as separate requests** — the whole worker chain (edge → projects →
membership → policy → billing …) is **one request** with **combined CPU time**.
So our fan-out inflates *CPU*, not request count. (Wall-clock I/O wait on DB /
subrequests is not CPU and is not billed.)

Included allowances / overage: requests **10M/mo, $0.30/M**; CPU **30M
CPU-ms/mo, $0.02/M**; KV read **10M, $0.50/M**; KV **write 1M, $5.00/M**; DO
request **1M, $0.15/M**; DO duration **400k GB-s, $12.50/M GB-s** (DO = 0.125 GB);
Cache API **free**; Hyperdrive **free** (the DB itself is Supabase — a separate,
usually larger, recurring cost).

Per end-user request, the billable Cloudflare meters:

| Meter | Read (GET) | Write (POST/PATCH/DELETE) |
| --- | --- | --- |
| Workers requests | 1 | 1 |
| Workers CPU | combined across ~4 workers | combined across ~5 workers + DB tx |
| KV ops | **0** (rate-limit in-isolate; actor cache = Cache API) | idempotency only: 1 read + on-miss 1 write *if `Idempotency-Key` sent* |
| DO ops | **0** | 2 requests (org+identity buckets) + duration |

**PERF5 was a cost win, not just latency.** It removed the per-request **KV write
($5/M)** from the rate-limit path on every request. At 50M req/mo (≈2 buckets/req):
the old KV limiter ≈ **$540/mo** (≈100M KV writes); the new path ≈ **$1.35/mo** (DO
requests) → **~99% cut** *and* now race-free.

Free-tier capacity ("how many requests"): the **10M-request** allowance is *not*
the binding constraint — **CPU and DO-requests** are. Rough model at ~85/15
read/write and ~10 CPU-ms/request (measure to confirm — CPU is the weakest input):
CPU caps ≈ **30M ÷ 10 ≈ 3M req/mo**; DO-requests cap ≈ **1M ÷ (2×0.15) ≈ 3.3M
req/mo**. So **~3M end-user requests/month sit within the included allowances**,
and the 10M request ceiling is reached well before request-overage matters.
Beyond that, overage is cheap — marginal Cloudflare cost ≈ **~$4/mo at 10M req**
and ≈ **~$55/mo at 50M req**, the latter dominated by **idempotency KV writes**
(another reason to move that lookup to the Cache API — see PERF6 findings).

## What this document is not

- Not a delivery-date list — sequencing is the Orchestrator's call.
- Not a replacement for the per-component specs under `specs/components/*.md`.
- Not a frozen plan — re-measure before scoping; trust code + live numbers over
  these notes (they were already stale once).
</content>
