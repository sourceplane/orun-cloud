# Sub-epic: billing-provider-abstraction

**Make the payment provider a swappable adapter behind the billing contract —
ship [Polar](https://polar.sh) first, switch to Stripe (or others) later by
config, not rewrite.** This is the sub-epic of `saas-multi-org-billing` that
provides the actual checkout, customer portal, and provider→state sync the
multi-org model bills through. It also realizes (and generalizes) `saas-baseline`
**B6**, whose original wording named Stripe specifically.

## Status

| Field | Value |
|-------|-------|
| Status | **In progress** — BP0 interface (#254), BP1 Polar adapter (#260), and BP2 edge/contracts/SDK/console (#261–#263) shipped. Polar is live end-to-end (pending webhook-endpoint registration in the Polar dashboard). BP3 (Stripe) + BP4 (hardening) remain. |
| Parent epic | [`saas-multi-org-billing`](../../README.md) |
| Cluster | **B** (realizes/generalizes B6) |
| Owner(s) | `apps/billing-worker` + `apps/api-edge` + `packages/contracts`/`sdk` + `web-console-next` |
| Target branch | `main` |
| Builds on | `components/11-billing.md` (Extraction Seam: "the payment processor is an adapter behind [the billing Worker], not the source of truth"), `packages/db/.../110_billing_foundation` (already has `provider` / `provider_*_id` columns) |
| Decisions locked | (0) **Polar is the first/active provider** (D1, 2026-06-08 — Merchant of Record); Stripe is the second impl that proves the seam; (1) one `BillingProvider` interface; provider chosen per-env by config (default `polar`); (2) **entitlement decisions never read live from the provider** — provider mutates our state via webhooks, gates read `billing.entitlements`; (3) no provider types/secrets in `packages/contracts`, the DB, `metadata`, or logs; (4) the billing-worker stays the system contract |

## Thesis

The billing schema and worker were built provider-neutral on purpose — every
billing table already carries opaque `provider` / `provider_*_id` / `hosted_url`
columns, and `assign-plan` already materializes entitlements independent of any
provider. So "add a provider" is: define one adapter interface, implement it for
Polar, and select it by config. "Switch providers" is: implement the interface
again (Stripe) and flip the config — with a documented policy for in-flight
subscriptions. No contract, schema, or entitlement-path change either way.

## The adapter interface (provider-neutral)

```
interface BillingProvider {
  id: "polar" | "stripe" | …
  createCheckout(input): { checkoutUrl }            // purchase
  createPortalSession(input): { portalUrl }         // manage
  getCustomerByExternalId(externalId): customerRef  // org ↔ provider customer
  verifyWebhook(rawBody, headers): NormalizedEvent  // signature-verified
}
```

`NormalizedEvent` is a small internal union (`subscription.activated|updated|
canceled`, `invoice.recorded|paid`, `payment.failed`) that maps onto the events
the billing-worker already emits — so intake is provider-agnostic and reuses
`assign-plan` materialization.

## Read order

1. `README.md` (this file).
2. `design.md` — the interface, the Polar implementation, the Stripe/other path, and the switching policy.
3. `implementation-plan.md` — BP0–BP4.
4. Parent: [`../../design.md`](../../design.md) — where the provider's "customer" is the billing **parent** org.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| BP0 | Define `BillingProvider` interface + provider registry + per-env config/secrets + `NormalizedEvent` | ✅ Shipped (#254) |
| BP1 | **Polar adapter** (checkout, customer portal, Standard-Webhooks verify + event map) | ✅ Shipped (#260) |
| BP2 | Edge + contract + SDK + console surfaces (checkout/portal POSTs, public webhook intake, two SDK write methods, upgrade/manage UI) | ✅ Shipped (#261–#263) |
| BP3 | **Stripe adapter** (second impl proving the seam) + provider-switch policy | 🗓️ Planned |
| BP4 | Hardening: idempotent intake, reconciliation/backfill, entitlement-observability counts (B9) | 🗓️ Planned |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The provider adapter seam, Polar (first) + Stripe (second) impls, checkout/portal/webhook surfaces, normalized intake | What a plan *grants* (stays in `plan-catalog.ts`); the multi-org tenancy model (parent epic); usage-based/metered billing (a future `metering` + provider-meters leg) |
