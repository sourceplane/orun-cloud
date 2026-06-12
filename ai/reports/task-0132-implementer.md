# Task 0132 — PERF3: DB query efficiency — Implementer Report

Milestone `PERF3-db-efficiency`. Branch `impl/task-0132-db-efficiency`.
Backend (packages/db + billing/membership workers). No contract change.

## Scope delivered (the safe, fully-testable wins)

1. **Parallelized `getBillingSummary`** (`packages/db/src/billing/repository.ts`)
   — 4 sequential round-trips → **2 parallel phases** on the shared connection
   pool: phase 1 `[customer, activeSubscription]`, phase 2
   `[plan, entitlements]` (plan still follows because it needs the resolved
   subscription). Query *order* is preserved so the order-based repo test mock
   stays valid. This is the endpoint measured at ~3.1s — the dominant part was
   the 4 serial queries.
2. **Fixed the member-list N+1** — new (optional) repo method
   `listRoleAssignmentsForSubjects(orgId, subjectIds[])` issuing **one** query
   (`subject_id = ANY($1)`) returning a `subjectId → RoleAssignment[]` map.
   `handleListMembers` uses it for the whole page instead of one query per
   member; a 50-member page drops from 50+ queries to 1. The method is
   **optional** on the interface so existing fakes/callers degrade gracefully to
   the per-subject path (zero test churn); the live repository always
   implements it.
3. **Single executor in `check-entitlement`** — the billing entitlement check
   (gates project/env/invite creation) opened **two** Hyperdrive clients per
   request (repo + decision-observation recorder). They now share **one**
   executor per request on the default path.

## Tests & gates

- db suite **525 passing** (billing-summary parallelization preserves result +
  order); billing-worker **65**; membership-worker **247** including a new
  PERF3 test asserting the batched lookup runs **once** for a page and the
  per-member N+1 is gone (only the actor authz check hits `listRoleAssignments`).
- typecheck + lint clean across db, billing-worker, membership-worker, tests.

## Deliberately deferred (documented, not done here)

These were in the PERF3 task but carry runtime risk / migration machinery that
warrants a separate, stage-verified change:

- **Module-scoped connection reuse** — the biggest single lever: today every
  worker does `createSqlExecutor` (new `postgres()` client) + `sql.end()` **per
  request**, so the TLS/auth handshake recurs every request in every hop (the
  ~0.5–1s/worker floor measured). Reusing a warm-isolate client is subtle under
  Workers' cross-request I/O constraints and unsafe to merge without a stage
  canary (a wrong move errors every query in prod). **Recommend a dedicated
  follow-up** that lands behind a measured stage rollout. This is where the
  remaining first-load latency lives.
- **Reverse-lookup index** (`membership.organization_members (subject_id, …)` /
  role_assignments subject index) — needs a migration + manifest/checksum entry;
  split into its own small migration PR.
- **Hyperdrive cache-eligibility audit** — verify reads aren't wrapped in
  transactions; pairs naturally with the connection-reuse follow-up.

## Live verification

Pending stage deploy: re-measure `/billing/summary` TTFB (expect a clear drop
from the ~3.1s baseline as the 4 queries collapse to 2 phases) and confirm
member-list TTFB stays flat as member count grows.
