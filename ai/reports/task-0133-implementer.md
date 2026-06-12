# Task 0133 — PERF4 implementer report

**Milestone:** PERF4-hop-reduction-observability
**Branch:** `impl/task-0133-perf-observability`
**Status:** implemented, unit-tested; live stage verification pending post-merge deploy.

## What shipped

### 1. Shared `Server-Timing` utility (`@saas/contracts/timing`)
New dependency-free helper `createTimings(now?)` returning a `Timings` with
`start(name)`, `measure(name, fn)`, `add(name, ms)`, `phases()`, `header()`,
`toJSON()`; plus `parseServerTimingDuration()` and `appendServerTiming()`.
Header values are sanitized (token-safe names, quoted descriptions stripped),
durations rounded and clamped ≥ 0. Lives in `@saas/contracts` — already a
dependency of api-edge and all four hot-path workers, so importing it forces
those services into the Orun changed-set and they redeploy (sidesteps the
shared-package cascade gap that bit task 0134). 12 unit tests.

### 2. Parallelize authorize ∥ read on the four hot reads
On each hot read the authorization-context fetch and the resource read are
independent — the read does not depend on the authz result for WHAT to read,
only WHETHER to return it. They now run concurrently via `Promise.all`, the
policy decision is applied afterward, and the speculatively-read data is
**discarded on deny** (deny-by-default preserved). Endpoints:

- **projects-list** (`apps/projects-worker/src/handlers/list-projects.ts`):
  `fetchAuthorizationContext` ∥ `listProjectsPaged`, then `authorizeViaPolicy`.
- **audit-list** (`apps/events-worker/src/handlers/list-audit.ts`):
  `fetchAuthorizationContext` ∥ `queryAuditByOrg`, then `authorizeViaPolicy`.
- **billing-summary** (`apps/billing-worker/src/handlers/get-summary.ts`):
  `authorizeBillingRead` (context+policy helper, untouched for its other
  callers) ∥ `getBillingSummary`. Also added a `try/finally` that disposes the
  per-request executor (was previously leaked) and an injectable `repo` for tests.
- **members-list** (`apps/membership-worker/src/handlers/list-members.ts`):
  actor-roles read ∥ `listMembersPaged`, then `authorizeViaPolicy`; the page
  role-enrichment (PERF3 batched lookup) stays after the allow decision.

### 3. Server-Timing + structured logs
Each worker `http.ts` gained `withTimings(response, requestId, route, timings)`
which sets the `Server-Timing` header (phases `authctx`/`db`/`policy`/`total`,
plus `enrich` for members) and emits a structured `{msg:"timing", route,
requestId, phases}` log line. api-edge's `http.ts` gained `withEdgeTimings`
which **appends** the edge's own `edge_auth`/`edge_downstream`/`edge_total`
phases to the downstream worker's `Server-Timing` header — so a single response
carries the full edge→worker→db breakdown. Applied in project/audit/billing/org
facades.

## Open decisions (resolved)
- **Hop reduction depth:** chose parallelize-only (no combined facts+read
  internal call) — it captures the latency win without crossing bounded-context
  boundaries (no worker reads another context's tables). A combined internal
  call was judged not worth the contract surface for this pass.
- **Analytics Engine:** deferred. Structured logs + `Server-Timing` are in place;
  wiring the metrics sink + p50/p95 dashboards is a follow-up.

## Verification
- Unit tests: contracts timing 12/12; projects-worker 172 (incl. PERF4 deny-no-leak
  + header tests); events-worker 26; billing-worker 67 (incl. PERF4 200 + deny
  no-leak); membership-worker 249 (incl. PERF4 deny-no-leak + header); api-edge
  313 (incl. edge Server-Timing append test). typecheck + lint clean across all
  six packages.
- Deny-by-default explicitly tested per endpoint: a denied authz returns 404 and
  the response body never contains the speculatively-read data.
- Live stage: confirm `Server-Timing` present on the four hot reads and that the
  phase breakdown matches external curl TTFB once the post-merge deploy converges.

## Follow-ups
- Analytics Engine sink + per-route p50/p95 dashboards.
- Reverse-lookup index migration; Hyperdrive cache-eligibility audit (other PERF
  backlog items).
