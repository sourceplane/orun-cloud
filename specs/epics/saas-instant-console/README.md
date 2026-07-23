# Epic: saas-instant-console

**Every surface interactive in under a second; every interaction under 100ms.**
The product-feel performance program. `saas-performance` (PERF) made the
*server* fast — org-scoped reads now hit ~55–65ms p50 at the edge — yet the
product still *feels* slow: a 2026-07-23 full-surface walkthrough measured
**4.6s first contentful paint**, a **4.5s stall on Activities**, pages ghosted
behind a re-run entrance fade long after data arrived, and a ⌘K that cannot
find a service by name. The budget has moved again: from the request path to
the **boot chain, rendering strategy, and perceived speed** of the console —
plus three newly-found slow endpoints the PERF ladder does not cover.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** |
| Cluster | **IC** (IC0–IC9) |
| Owner(s) | `web-console-next`, `state-worker`, `membership-worker`, `api-edge`, `packages/db`, `packages/sdk` |
| Target branch | `main` |
| Builds on | [`saas-performance/`](../saas-performance/) (PERF1–PERF14), [`saas-console-ux/`](../saas-console-ux/) (U-track), [`saas-catalog-portal/`](../saas-catalog-portal/) |
| Delivers | PX6 (⌘K resource search) lands here as IC7 |
| End-state target | Cold FCP **< 1.5s** · warm route-to-content **< 300ms** · slowest authed read **< 500ms p50 warm** · zero duplicate fetches per boot · budgets enforced in CI |
| Measured | **2026-07-23** live prod walkthrough — see `design.md` |

## Thesis

PERF optimized the request; nobody owned the *experience*. Every route is a
`"use client"` page that fetches on mount behind an org-list gate, so first
paint always waits on `HTML → JS → hydrate → auth → org list → page queries` —
the profile fetch doesn't even *start* until ~2.6s in. The session boot
duplicates its own requests outside the query cache. A 280ms entrance fade
re-runs on every navigation, ghosting content that is already on screen. One
endpoint (`/v1/state/runs`) issues ~51 sequential DB round-trips. The SSE tail
reconnects once per second against a deployment that may not stream. And the
command palette searches a static route list, so "find anything" finds nothing.

Each of these is individually small; together they are the difference between
"fast servers" and a product that feels instant. This epic owns that
difference, ordered by impact ÷ effort, with a measurement record
(`design.md`) and a CI-enforced budget at the end so the feel cannot regress
silently.

## Boundary with saas-performance

PERF owns request-path mechanics (edge gates, DB connection strategy,
response caching infra, observability sinks). IC owns the surface: boot chain,
rendering strategy, perceived speed, interaction affordances — and the named
endpoint fixes from the 2026-07-23 audit that no PERF task covers. Where an IC
milestone touches PERF territory it rides the PERF task rather than forking it
(noted inline: PERF9 connection reuse, PERF13 authz micro-cache, PERF6 AE
dashboards).

## Read order

1. `README.md` (this file).
2. `design.md` — the 2026-07-23 measurement record, per-surface timings, and
   root-cause analysis with file/line references.
3. `implementation-plan.md` — IC0–IC9 with status + "done when".

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| IC0 | Full-surface measurement record (2026-07-23 audit) | ✅ Landed with this epic (`design.md`) |
| IC1 | Kill the Activities stall — `/state/runs` N+1 + slow-endpoint quick wins | 🗓️ Planned |
| IC2 | One boot, one fetch — dedupe the session boot chain | 🗓️ Planned |
| IC3 | Paint from cache — persisted query cache + render-before-fetch | 🗓️ Planned |
| IC4 | Perceived-speed pass — entrance fade, skeleton discipline, SWR rendering | 🗓️ Planned |
| IC5 | Immutable by digest, cached like it — catalog docs path | 🗓️ Planned |
| IC6 | Streams that actually stream — SSE verification + reconnect discipline | 🗓️ Planned |
| IC7 | ⌘K finds anything — data-backed palette (delivers PX6) | 🗓️ Planned |
| IC8 | Big-list hygiene — virtualization, prefetch dedupe, row affordances | 🗓️ Planned |
| IC9 | Budgets in CI — perf budgets enforced per PR + RUM dashboard | 🗓️ Planned |
