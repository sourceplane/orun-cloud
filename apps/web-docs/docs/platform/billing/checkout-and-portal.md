---
title: Checkout, invoices & the billing portal
description: Purchase and change plans, read invoices and payment methods, and understand how inbound provider webhooks apply billing state.
---

Billing runs on a **provider adapter**: Orun Cloud stores plans, subscriptions, entitlements, and invoices itself, and hands payment off to a hosted provider. The active provider is **Polar** (Merchant of Record) — it serves an **embedded checkout** for purchases and a **hosted customer portal** for subscription and payment-method management. Your client only ever receives safe, hosted URLs; authoritative state changes arrive through signature-verified provider webhooks, never from the browser.

:::note
A **Stripe** path exists behind the same adapter seam but is credential-blocked and not active. `polar` is the configured provider; an unconfigured provider fails closed with `503 provider_unavailable`.
:::

## Endpoints and permissions

All routes are workspace-scoped. Reads require `billing.read`, writes require `billing.manage` — both held by the **owner** and **billing_admin** workspace roles and, cascading from a parent account, **account_owner** and **account_billing_admin**. The workspace `admin` role deliberately has no billing permissions. Denied requests return `404 not_found`.

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{id}/billing/plans` | `billing.read` | List catalog plans (`?status=active\|archived`) |
| `GET` | `/v1/organizations/{id}/billing/customer` | `billing.read` | The workspace's billing customer |
| `GET` | `/v1/organizations/{id}/billing/summary` | `billing.read` | Customer + active subscription + plan + entitlements |
| `GET` | `/v1/organizations/{id}/billing/invoices` | `billing.read` | List invoices (cursor-paginated) |
| `GET` | `/v1/organizations/{id}/billing/entitlements` | `billing.read` | Effective entitlement rows |
| `GET` | `/v1/organizations/{id}/billing/payment-methods` | `billing.read` | Saved cards (brand, last4, expiry only) |
| `POST` | `/v1/organizations/{id}/billing/checkout` | `billing.manage` | Start an embedded/hosted checkout |
| `POST` | `/v1/organizations/{id}/billing/portal` | `billing.manage` | Create a hosted customer-portal session |
| `POST` | `/v1/organizations/{id}/billing/subscription/change` | `billing.manage` | Change plan natively (no redirect) |
| `POST` | `/v1/organizations/{id}/billing/subscription/cancel` | `billing.manage` | Cancel the paid subscription |
| `POST` | `/v1/organizations/{id}/billing/reconcile` | `billing.manage` | Self-heal state from the provider |
| `POST` | `/v1/billing/webhooks/polar` | — (signature-verified) | Inbound provider webhook intake |

For child workspaces under a billing parent, checkout, portal, and billing reads resolve to the parent's subscription — see [Plans & entitlements](/platform/billing/plans-and-entitlements).

## Start a checkout

`POST /v1/organizations/{id}/billing/checkout` takes a purchasable `planCode` (`pro` or `business` — `free` and `enterprise` are rejected) and returns a URL to send the buyer to. Optional fields tailor the flow: `embedOrigin` (your console's origin, server-validated) lets the checkout render as an in-app embedded overlay instead of a full-page redirect, and `returnPath` (a root-relative path) brings the buyer back to your app after a hosted checkout.

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c/billing/checkout" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 4c1de6a0-2f57-4f7e-b6b3-8f0a2d9c1e77" \
  -d '{
    "planCode": "pro",
    "embedOrigin": "https://app.orun.dev",
    "returnPath": "/orgs/acme/settings/billing?checkout=complete"
  }'
```

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const { checkoutUrl, mode } = await client.billing.createCheckout(
  "org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c",
  { planCode: "pro", embedOrigin: "https://app.orun.dev" },
);
window.location.assign(checkoutUrl);
```

```json
{
  "data": {
    "checkoutUrl": "https://polar.sh/checkout/aa4f2f0c…",
    "mode": "checkout"
  },
  "meta": { "requestId": "req_01j9x4c2vn", "cursor": null }
}
```

`mode` tells you what kind of URL you got: `checkout` for a first purchase, or `portal` when the account already has an active paid subscription — providers reject a second checkout, so paid→paid changes are routed to the customer portal instead. Redirect to `checkoutUrl` either way.

:::note
The checkout call creates no local billing state. The plan is applied only when the provider's signature-verified webhook confirms payment — reloading your billing page a few seconds after purchase shows the new plan.
:::

## Open the billing portal

`POST /v1/organizations/{id}/billing/portal` (no body) returns a hosted **customer portal** URL where the buyer manages the subscription and payment method:

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c/billing/portal" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```ts
const { portalUrl } = await client.billing.createPortalSession(orgId);
```

## Change or cancel without a redirect

Two native writes cover the flows the console offers inline. Both return acknowledged intent — the authoritative state change still lands via the provider webhook:

- `POST …/billing/subscription/change` with `{ "planCode": "business" }` moves an existing paid subscription to another plan (proration is handled provider-side). Response: `{ "changed": true }`. First purchases must go through checkout.
- `POST …/billing/subscription/cancel` (no body) cancels the paid subscription. Response: `{ "cancelAtPeriodEnd": true }` when the provider schedules cancellation at period end rather than immediately.

```ts
await client.billing.changePlan(orgId, { planCode: "business" });
await client.billing.cancelSubscription(orgId);
```

## Read invoices and payment methods

`GET …/billing/invoices` lists invoices with `status` (`draft` | `open` | `paid` | `void` | `uncollectible`), amounts in minor units, the billing period, and a `hostedUrl` safe to show the customer. Filter by `status` or `subscriptionId`; paginate with `limit` + `cursor`. `GET …/billing/payment-methods` returns display-safe card facts only — `brand`, `last4`, `expMonth`, `expYear` — never a full card number.

```ts
const { invoices } = await client.billing.listInvoices(orgId, { status: "paid" });
const { paymentMethods } = await client.billing.listPaymentMethods(orgId);
```

## Reconcile after a missed webhook

If a provider webhook was dropped, `POST …/billing/reconcile` re-reads the provider and self-heals local state. `{ "reconciled": false, "reason": "…" }` is a normal outcome (for example, no provider subscription exists), not an error:

```ts
const result = await client.billing.reconcile(orgId);
// { reconciled: true, planCode: "pro" }
```

## Inbound provider webhooks

Polar delivers billing events to `POST /v1/billing/webhooks/polar` — the one billing route with no session, called by the provider directly. The edge does not parse or verify anything: it streams the **raw body** plus the [Standard Webhooks](https://www.standardwebhooks.com/) signature headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`; `svix-*` aliases accepted) to the billing service, which verifies the HMAC signature and fails closed — an invalid signature is rejected with `401`.

:::warning
The webhook signing secret lives only in the billing service, never at the edge. Verification happens next to the secret, on the exact bytes the provider signed. No unverified webhook payload can change billing state.
:::

Verified events apply idempotently: `subscription.activated` / `subscription.updated` assign the plan mapped from the provider product to the billing-parent workspace (and fan entitlements out to children); `subscription.canceled` downgrades to `free`. Provider redeliveries are safe — re-assigning an already-active plan is a no-op. This inbound surface is unrelated to your own **outbound** webhooks; for those, see [Webhooks](/platform/webhooks/overview).

## Related

- [Plans & entitlements](/platform/billing/plans-and-entitlements)
- [Billing API reference](/api/resources/billing)
- [RBAC](/platform/access-control/rbac)
- [Webhooks overview](/platform/webhooks/overview)
