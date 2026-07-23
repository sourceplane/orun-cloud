# saas-instant-console — Implementation Status

Running before/after record per milestone. Baselines from the 2026-07-23
audit (`design.md`); each milestone re-measures its own surface.

| ID | Milestone | Status | Metric | Before | After |
|----|-----------|--------|--------|--------|-------|
| IC0 | Measurement record | ✅ Landed (epic PR #583) | — | — | `design.md` |
| IC1 | Activities stall — `/state/runs` N+1 | ✅ | DB round-trips per 50-run page | **51** (measured: harness replay of the handler; prod effect 4.3–4.5s) | **2** (list + grouped counts; simulated serial wall-clock 4,335ms → 170ms @85ms/trip) |
| IC2 | One boot, one fetch | ✅ | boot requests per endpoint (network trace, mocked API) | post-auth boot: `GET /v1/auth/profile` ×2 + boot-window `PATCH /v1/auth/profile`; fresh-device warm boot: profile ×2 concurrently in flight | every boot endpoint exactly ×1; redundant PATCH eliminated (debounced 2s off the boot window, skipped when the server already has the slug) |
| IC3 | Paint from cache | ✅ | boot-read departure · revisit fetches · revisit content-visible (local prod build, mocked API @300ms org reads) | first API leaves 191ms after nav (prod audit: ~2,600ms); revisit re-fetches everything (7 reqs); Activities full-reload revisit content at 527ms | first API leaves **65ms** (pre-hydration primer, −66%); revisit issues **2** reqs (persisted cache); Activities revisit content at **384ms** same-run / **~100ms with 0 data fetches** isolated; warm SPA nav with fresh cache: **0** fetches (residual ~400ms blank = route mount + entrance fade → IC4) |
| IC4 | Perceived-speed pass | ✅ | opacity trace on cached nav · Agents content-visible | fade re-ran per nav: already-painted content knocked to **0.13 opacity** mid-nav, back to 1.0 over 280ms; Agents 977ms (2 sequential request batches) | **no ghost frame** (opacity 1.00 at every 55ms sample through the nav); Agents **679ms** (−31%, one parallel batch; floor 2×RTT → 1×RTT). Events + 5 minor surfaces still hand-roll loading state → spun off as follow-up |
| IC5 | Docs by digest | ✅ | queries/scans per doc open · repeat-open cost · cacheability | every open ran 2 leading-wildcard LIKE seq-scan legs + 1 indexed leg in one UNION (audit: 1.0–1.3s/open), repeat opens re-paid DB+R2, no cache-control | indexed doc: **1 exact-match query, 0 LIKE legs** (fallback only on index miss); response `public, max-age=31536000, immutable`; per-actor edge read-through: repeat open = **0 DB queries, 0 R2 GETs, 0 downstream touches** (1h TTL bound on the edge copy) |
| IC6 | Streams that stream | ✅ (client discipline) / ⚠️ prod passthrough validation pending | reconnects per minute under the audit pathology · streams per org | ~1/s spin (fixed 1s floor; sim: **60 connections/min**); one tail per surface/tab | exponential backoff + jitter (sim: **5 connections/min**, −92%); healthy 55s cadence unchanged; **1 stream per org across tabs** (Web Lock leader + BroadcastChannel fan-out, degraded per-tab fallback). **Prod validation still required**: whether the deployed path holds ~55s SSE legs (design §3.6) — decides D2 (keep SSE vs DO-relay WebSocket). Static review found no edge-side buffering of stream GETs (replayOrExecute only buffers unsafe+keyed methods); the ~1/s prod observation remains unexplained by code — needs a live authenticated probe |
| IC7 | ⌘K finds anything | 🗓️ | entity search results | 0 results | — |
| IC8 | Big-list hygiene | 🗓️ | catalog scroll / row nav | unvirtualized, chevron-only | — |
| IC9 | Budgets in CI | 🗓️ | CI-enforced budgets | none | — |

## IC1 — detail (2026-07-23)

- `handleListOrgRuns` / `handleListRuns`: per-run `getRunJobCounts` await
  loop replaced with one grouped `getRunJobCountsBatch` round-trip
  (`jsonb_to_recordset` exact (project, run) pair match, `GROUP BY run_id`).
  51 round-trips → 2 for a full `DEFAULT_PAGE_LIMIT=50` page. Parity with
  the per-run loop (incl. zero-count runs) guarded by
  `tests/state-worker/src/run-job-counts-parity.test.ts`; the ≤2-trip budget
  by `tests/state-worker/src/runs-roundtrips.bench.test.ts`.
- `resolve-owners`: the two independent batched queries (teams + aliases)
  now issue concurrently (`Promise.all`) — halves the query-bound part of
  the audit's 1.29s.
- `/state/*` facade now emits `Server-Timing` (`edge_total`, `edge_auth`,
  `edge_downstream`) via `withEdgeTimings`, closing the observability hole
  that hid the stall (extends PERF14b).

Prod p50 for `/v1/state/runs` after deploy to be confirmed on the next
walkthrough (re-measure rides IC3 per the plan); the round-trip count is the
deterministic guard.
