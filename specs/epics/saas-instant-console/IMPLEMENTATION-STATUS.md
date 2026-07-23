# saas-instant-console — Implementation Status

Running before/after record per milestone. Baselines from the 2026-07-23
audit (`design.md`); each milestone re-measures its own surface.

| ID | Milestone | Status | Metric | Before | After |
|----|-----------|--------|--------|--------|-------|
| IC0 | Measurement record | ✅ Landed (epic PR #583) | — | — | `design.md` |
| IC1 | Activities stall — `/state/runs` N+1 | ✅ | DB round-trips per 50-run page | **51** (measured: harness replay of the handler; prod effect 4.3–4.5s) | **2** (list + grouped counts; simulated serial wall-clock 4,335ms → 170ms @85ms/trip) |
| IC2 | One boot, one fetch | 🗓️ | duplicate boot fetches | profile ×2–3, org reads ×4 | — |
| IC3 | Paint from cache | 🗓️ | warm route-to-content / cold FCP | 1.5–3s / 4,636ms | — |
| IC4 | Perceived-speed pass | 🗓️ | ghost frames on cached nav | 280ms fade per nav | — |
| IC5 | Docs by digest | 🗓️ | doc open warm | 1.0–1.3s | — |
| IC6 | Streams that stream | 🗓️ | SSE reconnect cadence | ~1/s | — |
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
