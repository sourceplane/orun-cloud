---
title: Billing
description: Plans, billing summary, invoices, entitlements, checkout and portal sessions, native plan changes, and the provider webhook ingress.
---

The **billing API** exposes a workspace's plan, subscription, invoices, and **entitlements**, plus provider hand-off endpoints for hosted checkout and the customer portal. Plans and entitlement semantics are described in [Plans and entitlements](/platform/billing/plans-and-entitlements); the purchase flow in [Checkout and portal](/platform/billing/checkout-and-portal).

All routes are workspace-scoped under `/v1/organizations/{orgId}/billing/…`. Reads require `billing.read`; writes require `billing.manage` (held by workspace owners and `billing_admin`).

:::note
The active billing provider is **Polar** (embedded checkout + hosted portal). A Stripe path exists in the codebase but is credential-blocked and not serving traffic.
:::

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{orgId}/billing/plans` | `billing.read` | List available plans |
| `GET` | `/v1/organizations/{orgId}/billing/customer` | `billing.read` | The workspace's billing customer |
| `GET` | `/v1/organizations/{orgId}/billing/summary` | `billing.read` | Customer + subscription + plan + entitlements in one call |
| `GET` | `/v1/organizations/{orgId}/billing/invoices` | `billing.read` | List invoices (paginated) |
| `GET` | `/v1/organizations/{orgId}/billing/entitlements` | `billing.read` | List effective entitlements |
| `GET` | `/v1/organizations/{orgId}/billing/payment-methods` | `billing.read` | Saved cards (display-safe fields only) |
| `POST` | `/v1/organizations/{orgId}/billing/checkout` | `billing.manage` | Start a hosted checkout for a plan |
| `POST` | `/v1/organizations/{orgId}/billing/portal` | `billing.manage` | Create a customer-portal session |
| `POST` | `/v1/organizations/{orgId}/billing/subscription/change` | `billing.manage` | Change an existing paid plan natively |
| `POST` | `/v1/organizations/{orgId}/billing/subscription/cancel` | `billing.manage` | Cancel the paid subscription natively |
| `POST` | `/v1/organizations/{orgId}/billing/reconcile` | `billing.manage` | Re-sync billing state from the provider |
| `POST` | `/v1/billing/webhooks/polar` | — (provider only) | Inbound Polar webhook ingress — see below |

## Get the billing summary

One call returns everything the console's billing page needs: the customer record, the active subscription, its plan, and the effective entitlements.

```bash
curl https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/billing/summary \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "customer": {
      "id": "0d9c8b7a-6f5e-4d3c-2b1a-0f9e8d7c6b5a",
      "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
      "displayName": "Acme Inc",
      "email": "billing@acme.dev",
      "status": "active",
      "provider": "polar",
      "providerCustomerId": "cus_4f3e2d1c",
      "metadata": null,
      "createdAt": "2026-05-11T08:00:00.000Z",
      "updatedAt": "2026-06-30T10:22:00.000Z"
    },
    "activeSubscription": {
      "id": "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d",
      "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
      "billingCustomerId": "0d9c8b7a-6f5e-4d3c-2b1a-0f9e8d7c6b5a",
      "planId": "2b3c4d5e-6f7a-4b5c-9d0e-1f2a3b4c5d6e",
      "status": "active",
      "currentPeriodStart": "2026-07-01T00:00:00.000Z",
      "currentPeriodEnd": "2026-08-01T00:00:00.000Z",
      "trialEnd": null,
      "cancelAt": null,
      "canceledAt": null,
      "provider": "polar",
      "providerSubscriptionId": "sub_9e8d7c6b",
      "metadata": null,
      "createdAt": "2026-05-11T08:01:00.000Z",
      "updatedAt": "2026-07-01T00:00:05.000Z"
    },
    "plan": {
      "id": "2b3c4d5e-6f7a-4b5c-9d0e-1f2a3b4c5d6e",
      "code": "pro",
      "name": "Pro",
      "description": "For growing teams",
      "status": "active",
      "billingInterval": "month",
      "priceAmountCents": 2000,
      "priceCurrency": "usd",
      "metadata": null,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    },
    "entitlements": [
      {
        "id": "3c4d5e6f-7a8b-4c5d-0e1f-2a3b4c5d6e7f",
        "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
        "subscriptionId": "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d",
        "entitlementKey": "limit.projects",
        "valueType": "quantity",
        "enabled": true,
        "limitValue": 25,
        "source": "plan",
        "metadata": null,
        "createdAt": "2026-05-11T08:01:01.000Z",
        "updatedAt": "2026-05-11T08:01:01.000Z"
      }
    ]
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a24", "cursor": null }
}
```

With the SDK:

```ts
const summary = await client.billing.getSummary("org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9");
console.log(summary.plan?.code, summary.entitlements.length);
```

## Start a checkout

`planCode` is required and must name a purchasable plan (e.g. `pro`, `business`). `embedOrigin` (the console's `window.location.origin`) lets the returned checkout load as an embedded overlay; `returnPath` is a root-relative path to land back on after a hosted checkout. Both are server-validated and ignored if malformed. The plan is applied by the provider webhook after payment — not by this call.

```bash
curl -X POST https://api.orun.dev/v1/organizations/org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9/billing/checkout \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "planCode": "pro", "returnPath": "/orgs/acme/settings/billing?checkout=complete" }'
```

```json
{
  "data": { "checkoutUrl": "https://polar.sh/checkout/…", "mode": "checkout" },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a25", "cursor": null }
}
```

`mode` is `checkout` for a first purchase or `portal` when the workspace already has an active subscription (the provider manages paid→paid changes in the portal). Redirect to `checkoutUrl` either way.

`POST …/billing/portal` (no body) returns `{ "portalUrl": … }`. `POST …/billing/subscription/change` takes `{ "planCode": … }` and returns `{ "changed": true }`; `POST …/billing/subscription/cancel` (no body) returns `{ "cancelAtPeriodEnd": true }`. In all three the authoritative state change arrives via the provider webhook — the response only acknowledges intent. `POST …/billing/reconcile` self-heals a missed webhook; `{ "reconciled": false, "reason": … }` is a normal outcome, not an error.

## Provider webhook ingress (Polar — provider only)

`POST /v1/billing/webhooks/polar` is the one billing route with **no bearer token**: Polar calls it directly. Do not call it yourself — requests are authenticated by a **Standard-Webhooks** HMAC signature over the raw body, verified against the provider signing secret (fails closed). The edge streams the raw bytes and these headers through to the verifier:

| Header | Purpose |
|---|---|
| `webhook-id` | Unique delivery id |
| `webhook-timestamp` | Signing timestamp |
| `webhook-signature` | Standard-Webhooks HMAC signature |
| `svix-id` / `svix-timestamp` / `svix-signature` | Accepted compatibility aliases |

## Related

- [Plans and entitlements](/platform/billing/plans-and-entitlements)
- [Checkout and portal](/platform/billing/checkout-and-portal)
- [Usage & quotas](/api/resources/usage)
- [RBAC](/platform/access-control/rbac)
