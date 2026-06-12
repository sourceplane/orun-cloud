# billing-provider-abstraction — Implementation Plan (BP0–BP4)

PR-sized milestones. **BP0 → BP1 → BP2** is the critical line to a working
purchase; **BP1** can land in parallel with the parent epic's **MO1**. Nothing
here is built yet.

## BP0 — Provider interface, registry, config & normalized event — ✅ Shipped (#254)

- Define `BillingProvider` in `apps/billing-worker/src/billing-provider/` +
  a registry resolving the active provider from `BILLING_PROVIDER` (default
  `polar`). Add the `NormalizedEvent` union + the mapping to existing
  billing-worker events/actions (see `design.md` §2).
- Add per-provider secret/var slots to `billing-worker/src/env.ts` +
  `wrangler.jsonc` (no secrets committed). Add the per-env plan↔product map.
- Owner: `billing-worker`.
- **Done when:** the worker resolves a (stub) provider by config and the
  intake path compiles against `NormalizedEvent`; no public behavior change.

## BP1 — Polar adapter — ✅ Shipped (#260)

- Implement `BillingProvider` for Polar with `@polar-sh/sdk`
  (`server: sandbox|production`): `createCheckout`, `createPortalSession`,
  `getCustomerByExternalId`, and `verifyWebhook` via `validateEvent`
  (Standard Webhooks; fail closed). Map Polar `subscription.*`/`order.*` →
  `NormalizedEvent`.
- Webhook intake handler: verify → dedupe (`provider_webhook_events`) → reuse
  `assign-plan` materialization → emit existing events. Respond fast
  (Polar times out at 10s; `ctx.waitUntil` for best-effort event emission).
- Owner: `billing-worker` (+ `packages/db` for the dedupe table).
- Depends on: BP0; Polar creds (human-gated).
- **Done when:** a Polar **sandbox** checkout → webhook → entitlement
  materialization unlocks a gated action end-to-end.

## BP2 — Edge + contracts + SDK + console — ✅ Shipped (#261, #262, #263)

- api-edge: org-admin-gated idempotent `POST …/billing/checkout` &
  `…/billing/portal`; public signature-verified raw-body webhook passthrough.
- contracts: provider-neutral checkout/portal request+response types.
- sdk: `createCheckout` / `createPortalSession` (the two write methods).
- console: Upgrade + Manage-billing buttons; wire U7 `412` upgrade prompt
  (including the parent epic's multi-org gate) to checkout.
- Owner: `api-edge` + `packages/contracts`/`sdk` + `web-console-next`.
- Depends on: BP1.
- **Done when:** a user upgrades from the console, manages billing in the
  provider portal, and the console reflects plan state after the webhook lands.

## BP3 — Stripe adapter + provider-switch policy — 🗓️ Planned

- Implement the same interface for Stripe (checkout session, billing portal,
  signed webhook). Flip `BILLING_PROVIDER` to switch.
- Document + implement the in-flight policy: **new-subscriptions-only on the new
  provider**, dual-run by the per-row `provider` column; bulk migration is an
  optional follow-up.
- Owner: `billing-worker` (+ creds, human-gated).
- Depends on: BP0–BP2 (proves the seam is real).
- **Done when:** switching `BILLING_PROVIDER` to `stripe` routes new purchases
  through Stripe with zero contract/entitlement/console change; existing Polar
  subs keep syncing.

## BP4 — Hardening — 🗓️ Planned

- Reconciliation/backfill job (read-sync from the provider to repair missed
  webhooks). Entitlement-decision observability counts (ties to B9). Failed-
  payment dunning copy via B2.
- Owner: `billing-worker` + `admin-worker` + B2.
- Depends on: BP2.
- **Done when:** a dropped webhook self-heals on reconcile; gate hits are
  observable per caller × key; dunning fires on `payment.failed`.

## Sequencing note

Land **BP0+BP1** alongside the parent epic's **MO1** (both human-independent
modulo provider creds). **BP2** is the first buyer-visible surface and is the
checkout the parent epic's **MO2** upgrade gate points at. **BP3** is the proof
the abstraction is real — do it once Polar is live, not before.
