# Epic: saas-performance

**Make authenticated reads feel instant.** The "Performance & Caching (PERF)"
cluster as a full Orun-style epic. The measurement record, root-cause analysis,
and per-task plans live in `design.md` (promoted from the former
`specs/performance-epic.md`).

## Status

| Field | Value |
|-------|-------|
| Status | **In progress** (PERF1–PERF5 shipped + verified; PERF6 landing; PERF7–9 planned) |
| Cluster | **PERF** (PERF1–PERF9) |
| Owner(s) | `apps/api-edge`, `packages/contracts/timing`, `packages/db`, all DB-using workers, `web-console-next`, infra |
| Target branch | `main` |
| Builds on | `core/repo.md` (platform primitives), `core/contracts/` |
| End-state target | **p50 authed read < 150ms server-side** (warm), console instant on navigation, every hot-path phase measurable in prod |
| Last re-measured | **2026-06-08** (live stage + prod) — see `design.md` |

## Thesis

The 2026-06-02 baseline blamed per-request DB setup, uncached bearer resolution,
and serial multi-hop fan-out — all shipped (PERF1–PERF4). A fresh 2026-06-08
measurement showed the budget **moved**: the dominant cost was the edge rate
limiter doing a Workers-KV read-modify-write on every request, before auth, twice
for org-scoped routes (~264ms). PERF5 fixed it (reads → in-isolate limiter, writes
→ a Durable Object), taking org-scoped reads/writes from ~320ms to ~55–65ms p50 on
prod. PERF6 makes the whole request measurable; PERF7–9 chase cold starts, a
safe-GET edge cache, and at-scale DB.

## Read order

1. `README.md` (this file).
2. `design.md` — how it was measured, the live numbers, the root-cause analysis,
   and the per-task design (the normative detail).
3. `implementation-plan.md` — PERF1–PERF9 with status + "done when".
4. `IMPLEMENTATION-STATUS.md` — what shipped, with PRs.
5. `risks-and-open-questions.md` — the connection-reuse lesson + deferred leftovers.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| PERF1 | Console client cache, SWR & prefetch | ✅ Shipped (PR #216) |
| PERF2 | Edge bearer-resolution cache | ✅ Shipped (PR #220) |
| PERF3 | DB connection reuse & query efficiency | ✅ Shipped (PR #221); reuse leg reverted (#227) → PERF9 |
| PERF4 | Hot-path hop reduction + Server-Timing observability | ✅ Shipped (PR #230) |
| PERF5 | Take the rate limiter off the KV read-modify-write path | ✅ Shipped + verified (PRs #245/#246/#247) |
| PERF6 | Whole-request observability + p50/p95 dashboards | 🛠️ In progress (edge-gate measurability merged #248; AE sink + prober remaining) |
| PERF7 | Cold-start reduction (edge + console SSR) | 🗓️ Planned |
| PERF8 | Edge response cache for safe GETs | 🗓️ Planned |
| PERF9 | At-scale DB + deferred PERF3 leftovers | 🗓️ Planned |
