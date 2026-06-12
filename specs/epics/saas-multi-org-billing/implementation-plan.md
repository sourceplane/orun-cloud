# saas-multi-org-billing — Implementation Plan (MO1–MO6)

Each milestone is a candidate scope for one coherent PR-sized task (split into
follow-ups only on a clean seam). Sequencing is the Orchestrator's call, but the
hard dependency is **MO1 → everything** (the dormant seam) and **provider
sub-epic BP0/BP1 → MO2** (you cannot sell multi-org without a checkout). Status
markers reflect that nothing here is built yet.

## MO1 — Schema + resolution seam + multi-org entitlements — ✅ Shipped (#253 + #257)

Add the dormant machinery with **no behavior change**.

> **As-built:** shipped across two PRs. #253 — the schema/resolution seam
> (migration `170_membership_org_parent` + `Organization.parentOrgId` +
> `effectiveBillingOrgId`). #257 — the plan-catalog half: the D5 flat-tier
> catalog (Free/Pro/Business/Enterprise) + `feature.multi_org` +
> `limit.organizations` in `billing-worker/src/plan-catalog.ts`. `free` keeps
> `limit.environments = 3` (no-regress rule). Both dormant — nothing reads the
> new column/keys until MO2.

- Migration: nullable `organizations.parent_org_id` + partial index (see
  `design.md` §3); verify schema namespace against `020_membership_core`.
- Add `effectiveBillingOrg(org) = parent_org_id ?? org.id` helper in the
  membership/billing repository layer; route all billing reads through it
  (collapses to `org.id` for standalone orgs).
- Add `feature.multi_org` (boolean) + `limit.organizations` (quantity) to
  `billing-worker/src/plan-catalog.ts`; free/default plan grants neither.
- Owner: `packages/db` + `membership-worker` + `billing-worker`.
- **Done when:** migration applies idempotently; every existing org resolves to
  itself; the two new entitlement keys materialize on plan assign; **no public
  behavior changes** (regression suite green).

## MO2 — Purchase-gated org creation — ✅ Shipped (#265 gate + #266 console)

Make "create another organization" a paid, entitlement-gated action.

- First/bootstrap org: always allowed (unchanged). Additional org: gate on
  `feature.multi_org` enabled **and** child count `< limit.organizations`,
  checked against the billing parent via the existing `check-entitlement` client.
- Deny → `412 precondition_failed` with `disabled` / `not_configured` /
  `limit_reached`; render via **U7** upgrade UX with a checkout CTA.
- Owner: `membership-worker` + `web-console-next` (+ `packages/contracts` if a
  new reason needs surfacing).
- Depends on: MO1; provider sub-epic **BP0/BP1** (a checkout to upgrade into).
- **Done when:** a free-tier user is blocked from a 2nd org with the upgrade
  prompt; a multi-org-plan user can create up to `limit.organizations`.

## MO3 — Child lifecycle + entitlement fan-out — ✅ Shipped (#268, #269, #270)

> **As-built:** inherit-on-create (#268), re-fan-out on plan change + freeze
> children on cancel (#269), console suspended-org warning (#270). Per the
> chosen policy, downgrade **freezes** children (`status=suspended`, flag-only;
> access enforcement deferred) rather than detaching them to Free.

Make children inherit, stay in sync, and detach cleanly.

- On child create/attach: set `parent_org_id`; fan out the parent subscription's
  plan entitlements into the child's `(org_id, key)` rows (reuse `assign-plan`
  materialization, scoped to the child).
- On parent plan change/cancel: re-fan-out to parent + all children; emit
  `entitlements.updated` per org. Cancellation policy per risks (freeze vs detach).
- Detach: clear `parent_org_id` → standalone, bills for itself (reversible).
- Owner: `billing-worker` + `membership-worker`.
- Depends on: MO1, MO2.
- **Done when:** a child created under a Pro parent has Pro limits; downgrading
  the parent propagates within one webhook/assign cycle; detach restores
  standalone billing — all without touching `check-entitlement`.

## MO4 — Consolidated billing + usage rollup — ◐ Billing reads shipped (#272); usage rollup pending

One bill, parent-scoped; usage attributable per child.

- `getBillingSummary` / `listInvoices` / customer / subscription resolve to
  `effectiveBillingOrg` for any child.
- Provider customer = the parent org (`customerExternalId = parentOrgId`) — see
  the provider sub-epic; nothing provider-side is per-child.
- Usage: read-time aggregation summing children's `metering` rollups under the
  parent; expose "Overall vs Individual organizations".
- Owner: `billing-worker` + `metering-worker` (read aggregation only) + console.
- Depends on: MO3.
- **Done when:** a child's billing page shows the parent's subscription/invoices;
  the parent's usage view sums all children and can break down per org.

## MO5 — Console surfaces — 🗓️ Planned

- Org switcher groups children under their parent account.
- "Create organization" is gated with the upgrade prompt (MO2 UX).
- Billing settings live on the **default/parent** org and manage the whole
  account (plan, payment method via the provider portal, invoices, member/org
  limits, usage Overall vs Individual).
- Owner: `web-console-next` (+ `packages/sdk` if a read shape is missing).
- Depends on: MO2, MO4.
- **Done when:** the console makes the parent/child relationship and the single
  consolidated bill legible, Vercel/Datadog-credible.

## MO6 — Migration + reversibility — 🗓️ Planned

- Verify an existing single org becomes a parent on first child with **no data
  migration**; confirm `effectiveBillingOrg` back-compat for all standalone orgs.
- Detach path returns a child to standalone billing.
- Grandfathering: define behavior when a downgrade puts a parent over
  `limit.organizations` (per risks — block-new vs force-detach vs grandfather).
- Owner: `membership-worker` + `billing-worker` + a verifier task.
- Depends on: MO3.
- **Done when:** promotion/detach are proven reversible and lossless on a stage
  canary; the over-limit-downgrade policy is implemented and audited.

## Sequencing note

MO1 is human-independent and safe to land immediately (dormant seam). MO2 is the
first **buyer-visible** milestone and needs the provider sub-epic's checkout
(BP0/BP1) plus the product decisions in `risks-and-open-questions.md`. MO4/MO5
are the credibility layer; MO6 is the safety net. Prefer landing the provider
sub-epic's Polar adapter (BP1) in parallel with MO1 since they are independent.
