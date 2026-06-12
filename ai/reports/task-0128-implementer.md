# Task 0128 — Provider-neutral billing subscription & plan lifecycle — Implementer Report

Milestone `B11-billing-subscription-lifecycle`. Branch
`impl/task-0128-billing-subscription-lifecycle`.

## Outcome

The free tier is now a **real plan with materialized entitlement rows**, not just
the PR-#209 hard-coded fallback. Org bootstrap assigns the `free` plan, which
creates a subscription and writes `billing.entitlements` rows; `check-entitlement`
then reads real rows. Plan changes (upgrade/downgrade) re-materialize the
entitlement set. All provider-neutral — no Stripe, no credentials.

## What shipped

- **Plan catalog** (`apps/billing-worker/src/plan-catalog.ts`, pure/testable):
  `free` + `pro` plan definitions with per-plan entitlement sets
  (`limit.projects/environments/members` + a sample `feature.custom_domains`
  boolean that is off on free, on on pro). `DEFAULT_PLAN_CODE = "free"`. Free
  limits are kept `>=` the PR-#209 stopgap so retiring it can never regress.

- **Plan-assignment seam** (`handlers/assign-plan.ts` + internal route
  `POST /v1/internal/billing/plan/assign`, service-binding-only, allow-listed to
  `membership-worker`). One idempotent primitive covering **create** and
  **change**:
  1. ensures catalog plan rows exist (`createPlan` ON CONFLICT DO NOTHING — no
     data migration needed),
  2. ensures a billing customer (upsert by org),
  3. creates the active subscription (cancelling a prior active one on a plan
     change),
  4. materializes the plan's entitlements (idempotent upsert per `(org, key)`,
     `source: "plan"`, bound to the subscription),
  5. emits best-effort `subscription.created|updated` + `entitlements.updated`
     events.
  Orchestration (`assignPlanWithRepos`) is separated from the executor/transaction
  wiring so it unit-tests with fakes; the production path wraps the work in
  `executor.transaction` where available.

- **Bootstrap assignment** (`membership-worker/create-organization.ts` +
  `billing-client.ts` `assignPlan`): after a successful org bootstrap, the
  bootstrapping user's org is granted the `free` plan over the existing
  `BILLING_WORKER` binding, forwarding the actor so events attribute correctly.
  **Best-effort and non-blocking** — a transient billing failure never fails the
  bootstrap.

- **Stopgap demoted**: the PR-#209 `DEFAULT_TIER_ENTITLEMENTS` map in
  `check-entitlement.ts` is retained as a documented **last-resort safety net**
  (so a transient assignment failure can't hard-block the REQUIRED create flows)
  with values `>=` the free plan. It is normally never consulted now.

- **`getBillingSummary`** already returns customer + active subscription + plan +
  entitlements; it now reflects the real assigned plan with no handler change.

## Tests

- `tests/billing-worker/src/assign-plan.test.ts` (catalog invariants, body
  parsing, and `assignPlanWithRepos`: bootstrap create + entitlement
  materialization + events, idempotent re-assign, upgrade cancels old +
  raises limits, repo_error on subscription failure, best-effort event
  resilience). billing-worker suite: **65 passing**.
- `tests/membership-worker`: bootstrap calls `assignPlan` with the org public id;
  a throwing assignment still returns 201. membership suite: **246 passing**.
- typecheck + lint clean across billing-worker, membership-worker, and both test
  packages.

## Deliberately deferred (noted for the orchestrator)

- **Public api-edge upgrade/downgrade routes + SDK + console** —
  `createSubscription`/`changeSubscription` exist as the internal `assign-plan`
  primitive; exposing them publicly with the designed upgrade UX is **U7**, and
  the Stripe adapter behind the same seam is **B6**.
- **Explicit `cancelSubscription`** — `assign-plan` with `planCode: "free"` is the
  downgrade path; a dedicated cancel endpoint (mark canceled + revert to free)
  is a small follow-up.
- **Pre-0128 org backfill** — existing orgs created before this task still rely
  on the safety-net map until they next trigger an assignment; a one-shot
  backfill (assign free to all orgs lacking a subscription) can retire the map.
- A **data-seed migration** for the plan catalog (so `list-plans` shows the
  catalog before any subscription exists) was intentionally skipped in favor of
  idempotent ensure-on-assign, to avoid a live-migration-apply dependency.

## Live verification

Pending stage deploy on merge: confirm a brand-new org gets real free-plan
entitlement rows (`GET …/billing/entitlements`) and can create a project, and
that assigning `pro` raises the limits.
