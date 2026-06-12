# billing-provider-abstraction — Design

Status: Design locked. BP0/BP1 are human-independent except for provider creds.

## 1. Why this is mostly wiring

`components/11-billing.md` § Extraction Seam already mandates that "the payment
processor is an adapter behind [the billing Worker], not the source of truth for
product entitlement decisions." The schema honors it:
`billing.{billing_customers,subscriptions,invoices}` carry opaque `provider`,
`provider_customer_id`, `provider_subscription_id`, `provider_invoice_id`, and
`hosted_url` columns. `assign-plan` materializes entitlements with no provider
knowledge. This sub-epic fills in the adapter the seam was designed for.

## 2. The interface + registry (BP0)

A single `BillingProvider` interface (see README) lives in
`apps/billing-worker/src/billing-provider/`. A registry resolves the active
provider from a per-env var:

```
BILLING_PROVIDER = "polar" | "stripe"      # var, default "polar"
```

Secrets are **namespaced per provider** and set with `wrangler secret put …
--env <env>` (mirroring the B1 OAuth pattern — never in `wrangler.jsonc`, the DB,
or contracts):

```
POLAR_ACCESS_TOKEN   POLAR_WEBHOOK_SECRET   POLAR_SERVER(=sandbox|production)
STRIPE_SECRET_KEY    STRIPE_WEBHOOK_SECRET
```

Plan ↔ provider-product mapping is per-env config (e.g. `POLAR_PRODUCT_MAP`
JSON), so sandbox/prod product ids never enter the DB-of-record and adding a plan
stays a code change.

Given the decided flat-tier catalog (parent epic `design.md` §3), the mapping is:

| Plan `code` | Polar product |
|---|---|
| `free` | none — no provider product; the default plan needs no checkout |
| `pro` | one fixed-price Polar product (per env) |
| `business` | one fixed-price Polar product (per env) — the multi-org tier |
| `enterprise` | none — sold via "contact sales", not self-serve checkout |

So `POLAR_PRODUCT_MAP` carries exactly the `pro` and `business` product ids per
environment; checkout is only ever created for those two codes.

### NormalizedEvent

The adapter's `verifyWebhook` returns a small internal union that maps 1:1 onto
the events the billing-worker already emits:

| NormalizedEvent | Maps to existing action/event |
|-----------------|-------------------------------|
| `subscription.activated` | upsert subscription + `assign-plan` fan-out → `subscription.created` + `entitlements.updated` |
| `subscription.updated` | update period/status; re-assign on plan change |
| `subscription.canceled` | mark canceled/expired; downgrade per parent-epic policy → `subscription.canceled` + `entitlements.updated` |
| `invoice.recorded` / `invoice.paid` | `upsertInvoice` mirror → `invoice.generated` / `invoice.paid` |
| `payment.failed` | `payment.failed` (drives B2 dunning) |

Intake is therefore **provider-agnostic** — only `verifyWebhook` and the event
parsing differ per adapter.

## 3. Polar adapter (BP1) — first implementation

Uses `@polar-sh/sdk` (Workers-compatible), `server: "sandbox" | "production"`.

- **Checkout:** `polar.checkouts.create({ products: [productId],
  customerExternalId: <billing-parent orgId>, metadata: { orgId, planCode },
  successUrl })` → `{ checkoutUrl }`.
- **Customer portal:** `polar.customerSessions.create({ … })` → `{ portalUrl }`.
- **Customer lookup:** `polar.customers.getExternal({ externalId })`.
- **Webhook verify:** `validateEvent(rawBody, headers, POLAR_WEBHOOK_SECRET)` from
  `@polar-sh/sdk/webhooks` (Standard Webhooks spec; base64 secret;
  `WebhookVerificationError` → `403`, fail closed). Map Polar
  `subscription.*` / `order.*` events to `NormalizedEvent`.

Polar is a **Merchant of Record** — it is the legal seller and remits tax/VAT.
That posture is a product decision tracked in the parent epic's risks.

## 4. Surfaces (BP2)

- **api-edge** (`billing-facade`): allow authenticated, **org-admin-gated**,
  idempotent `POST …/billing/checkout` and `POST …/billing/portal`; add a
  **public, signature-verified** raw-body passthrough `POST
  /v1/billing/webhooks/<provider>` that bypasses actor resolution and
  identity rate-limiting and forwards raw bytes + signature headers to
  billing-worker. (Ensure Cloudflare Bot Fight Mode does not block it.)
- **contracts:** add provider-neutral `CreateCheckoutRequest`
  (`{ planCode }`) / `CreateCheckoutResponse` (`{ checkoutUrl }`) /
  `CreatePortalSessionResponse` (`{ portalUrl }`). No provider types leak.
- **sdk:** add the two intentional write methods `createCheckout` /
  `createPortalSession` (the billing client is otherwise read-only by design).
- **console:** plan cards with **Upgrade** (→ checkout redirect) and **Manage
  billing** (→ portal redirect); wire the **U7** `412` upgrade prompt (incl. the
  multi-org gate from the parent epic) to checkout.

## 5. Switching providers (BP3)

- Implement the same interface for Stripe (`stripe` SDK; checkout sessions,
  billing portal, webhook signature via `STRIPE_WEBHOOK_SECRET`). Flip
  `BILLING_PROVIDER` to switch.
- **In-flight subscription policy** (the only real switch cost): default to
  **new-subscriptions-only on the new provider** — existing subscriptions keep
  being served/synced by their original provider's webhooks until they churn or
  are migrated manually; the `provider` column on each row already records which
  adapter owns it, so dual-running is safe. A bulk migration tool is an optional
  follow-up, not required to switch.
- Because entitlements are materialized in our DB, a provider switch is invisible
  to every gating caller and to the product surface.

## 6. Security & correctness invariants

- Webhook signature verification mandatory; fail closed on bad/missing signature.
- Idempotent intake: dedupe by provider event id (a small
  `billing.provider_webhook_events` table, unique `(provider, event_id)`);
  idempotent checkout via `Idempotency-Key`.
- Checkout/portal are **org-admin only** (policy gate) — never anonymous.
- No secrets/tokens/raw payloads in contracts, the DB, `metadata`, or logs;
  `hosted_url` validated as a safe display URL (schema already constrains this).
- Entitlements are never read live from the provider on the request hot path → no
  provider outage can block product gates; deny-by-default preserved.
