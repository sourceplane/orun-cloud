# saas-multi-org-billing — Implementation Status (as-built)

Status: **In progress.** MO1 (schema seam + flat-tier catalog/entitlements) and
the entire `billing-provider-abstraction` sub-epic through **BP2** have shipped
to `main` — **Polar billing is live end-to-end** (webhook intake → entitlements,
console upgrade/manage). To exercise the live loop, the Polar webhook endpoint
must be registered in the dashboard (per env) and a `POLAR_SUCCESS_URL` set
(optional). Next: **MO3** (child lifecycle + entitlement fan-out) — so an
additional org created via the MO2 gate inherits the parent's plan and rolls
billing up, instead of being created standalone on Free.
This file tracks PR-level as-built state, kept distinct from the design/plan docs.

## Epic milestones (MO)

| Milestone | Status | PR(s) | Notes |
|-----------|--------|-------|-------|
| MO1 — schema + resolution seam + entitlements | ✅ Shipped | #253, #257 | #253: `170_membership_org_parent` (nullable `parent_org_id` + sparse index), `Organization.parentOrgId`, `effectiveBillingOrgId`. #257: the D5 flat-tier catalog (Free/Pro/Business/Enterprise) + `feature.multi_org` / `limit.organizations` entitlements. Dormant — applied cleanly to dev/stage/prod; no behavior change (Free's `limit.environments` kept at 3 per the no-regress rule). |
| MO2 — purchase-gated org creation | ✅ Shipped | #265, #266 | Additional-org gate on `feature.multi_org` + `limit.organizations` (bootstrap exempt) → `412`; console paywall with a Business-checkout "Upgrade" CTA. **Note:** the additional org is still created standalone on Free — parent linkage + entitlement fan-out is MO3. |
| MO3 — child lifecycle + entitlement fan-out | ✅ Shipped | #268, #269, #270 | Child linkage + fan-out on create (#268); re-fan-out + freeze on parent plan change/cancel (#269); console suspended-org warning (#270). Freeze is **flag-only** (status=suspended) — access enforcement of frozen orgs deferred. Detach-to-standalone not built (freeze policy chosen instead). |
| MO4 — consolidated billing + usage rollup | ◐ In progress | #272 | Billing reads (summary/invoices/customer) for a child resolve to the parent's single subscription via a membership billing-parent lookup (fail-safe to self). **Remaining:** usage rollup (sum children's metering at the parent, "Overall vs Individual"). |
| MO5 — console surfaces | 🗓️ Planned | — | |
| MO6 — migration + reversibility | 🗓️ Planned | — | |

## Sub-epic: billing-provider-abstraction (BP)

| Milestone | Status | PR(s) | Notes |
|-----------|--------|-------|-------|
| BP0 — provider interface + registry | ✅ Shipped | #254 | `BillingProvider` interface + `NormalizedEvent` union + config-driven registry (`BILLING_PROVIDER`, default polar) that fails closed. Dormant — empty adapter map until BP1. |
| BP1 — Polar adapter | ✅ Shipped | #260 | `@polar-sh/sdk` checkout/portal/customer + Standard-Webhooks `validateEvent` (fails closed) → `NormalizedEvent`. Bundles in workerd (156 KiB gzip). |
| BP2 — edge + contracts + SDK + console | ✅ Shipped | #261, #262, #263 | Public webhook intake (api-edge → billing-worker → assign-plan/downgrade), checkout/portal endpoints + contracts + SDK, and the console upgrade/manage-billing UI. Polar live end-to-end. |
| BP2.1 — in-app checkout UX | ✅ Shipped | #277, #279, #281 | Embedded checkout overlay (`@polar-sh/checkout`) so the buyer stays in the console + a "finalizing…" state that polls the summary until the webhook applies the plan. `embedOrigin`/`returnPath` make the hosted (non-embedded) fallback return same-origin into the console (`POLAR_SUCCESS_URL` is the per-env last-resort fallback); overlay theme matches the console. |
| BP2.2 — native subscription management | ✅ Shipped | #282 | Cancel **and** plan-change happen in-app via the Polar Customer Portal API (`customerPortal.subscriptions.cancel` / `.update`, customer-session token) — no hosted-portal redirect. The downgrade/upgrade still flows through the verified webhook; the console polls until it lands. The console routes existing paid subscribers' plan changes to the native change endpoint (checkout is first-purchase only). Updating the payment method remains a deep-link to the hosted portal (PCI); the card on file (brand + last4 + expiry) is shown natively next to it, read server-side with the org token (no provider session reaches the console). Polar's hosted portal is intentionally non-white-label, so all management UI is native and on the console URL. |
| BP3 — Stripe adapter + switch policy | 🗓️ Planned | — | |
| BP4 — hardening (reconcile, observability, dunning) | 🗓️ Planned | — | |

## Verified facts about today's code (the baseline this epic builds on)

- Organization is the billing boundary; `billing.*` tables are `org_id`-scoped
  (`uq_billing_customer_org`). Confirmed in `packages/db/.../110_billing_foundation`.
- Entitlements are materialized per-org and read via `check-entitlement`;
  consumed by `projects-worker` (project/env gates) and `membership-worker`
  (member-limit gate). Confirmed in `apps/*/src/billing-client.ts`.
- Org creation is **not** entitlement-gated today (bootstrap path). Confirmed in
  `membership-worker/src/handlers/create-organization.ts`.
- `parent_org_id` now exists (MO1) but is unread until MO2+; every org is
  standalone (`NULL`), so `effectiveBillingOrgId` collapses to `org.id`.
