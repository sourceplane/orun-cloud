---
title: Plans & entitlements
description: Orun Cloud's plan catalog, the entitlements model, and how entitlement checks gate actions across the platform.
---

A **plan** is a named tier in the global catalog; an **entitlement** is a per-workspace fact materialized from that plan — a quantity limit like `limit.projects` or a feature flag like `feature.multi_org`. When a plan is assigned, the platform writes one entitlement row per key for the workspace, and every product surface reads those rows. Enforcement therefore never inspects "what plan are you on" — it asks "is this entitlement enabled, and what is its limit".

## The plan catalog

Four flat tiers. Every new workspace starts on `free`; paid plans are purchased through the hosted checkout (see [Checkout, invoices & the billing portal](/platform/billing/checkout-and-portal)).

| Plan | Code | Price | How to get it |
|---|---|---|---|
| **Free** | `free` | $0 | Assigned automatically at workspace creation |
| **Pro** | `pro` | $20/month | Self-serve checkout |
| **Business** | `business` | $99/month | Self-serve checkout |
| **Enterprise** | `enterprise` | Custom | Contact sales — no self-serve checkout |

:::note
Catalog prices are nominal display values. Once the payment provider is wired for a deployment, the provider is the source of truth for what is actually charged; the catalog remains the source of truth for which entitlements each plan grants.
:::

## Entitlement values by plan

Quantity limits use `valueType: "quantity"`; flags use `valueType: "boolean"`. For quantity limits, **`enabled: true` with `limitValue: null` means unlimited**.

| Entitlement key | Free | Pro | Business | Enterprise |
|---|---|---|---|---|
| `limit.projects` (per workspace) | 3 | 25 | 100 | Unlimited |
| `limit.environments` (per project) | 3 | 3 | 5 | Unlimited |
| `limit.members` (per workspace) | 5 | 20 | 50 | Unlimited |
| `limit.organizations` (per account) | 1 | 1 | 5 | Unlimited |
| `limit.repo_links` (per workspace) | 1 | 10 | 50 | Unlimited |
| `feature.custom_domains` | — | ✓ | ✓ | ✓ |
| `feature.multi_org` | — | — | ✓ | ✓ |
| `feature.integrations.github` | ✓ | ✓ | ✓ | ✓ |

Two conventions are worth calling out:

- **GitHub integration on every tier.** `feature.integrations.github` is enabled everywhere — connecting a repo is an activation feature, not a paywall. Tiers differ only in the `limit.repo_links` cap.
- **Limits never regress on an in-use plan.** Plan changes to the catalog raise limits, never lower them, for any plan that live workspaces are on.

Each entitlement row also carries a `source` — `plan` (materialized from the plan) or `override` (a manual per-workspace adjustment layered on top).

## How entitlement checks gate actions

Product services never read billing tables. Before a gated write, the owning service asks the billing service for a **decision** on a single entitlement key:

- creating a project checks `limit.projects`,
- creating an environment checks `limit.environments`,
- inviting a member checks `limit.members`,
- linking a repository checks `feature.integrations.github` and `limit.repo_links`.

The decision is deliberately boring: `allowed: true` with the effective `limitValue` (`null` = unlimited), or `allowed: false` with a narrow reason — `disabled` (configured but off) or `not_configured` (no row for that key). A missing entitlement is a *denied decision*, never a 5xx, so callers fail closed deterministically. When a quantity limit is enabled, the calling service compares the current count against `limitValue` and rejects the write once the cap is reached — a `free` workspace's fourth project fails with a validation error prompting an upgrade.

This decision seam is internal (service-to-service). What you can read publicly is the materialized entitlement set, below. For metered consumption (build minutes, API requests) rather than object counts, see [Usage & quotas](/platform/metering/usage-and-quotas).

## Read a workspace's entitlements

`GET /v1/organizations/{id}/billing/entitlements` returns the effective rows (permission `billing.read`). Optional filters: `source=plan|override` and `subscriptionId`.

```bash
curl "https://api.orun.dev/v1/organizations/org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c/billing/entitlements" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const { entitlements } = await client.billing.getEntitlements(
  "org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c",
);
const projects = entitlements.find((e) => e.entitlementKey === "limit.projects");
```

```json
{
  "data": {
    "entitlements": [
      {
        "id": "2c4d6e8f-a0b1-c3d5-e7f9-0a1b2c3d4e5f",
        "orgId": "7f3a9c2e-51d8-4b6f-a0e2-c4d8b91f6a3c",
        "subscriptionId": "9e8d7c6b-5a4f-3e2d-1c0b-9a8f7e6d5c4b",
        "entitlementKey": "limit.projects",
        "valueType": "quantity",
        "enabled": true,
        "limitValue": 25,
        "source": "plan",
        "metadata": null,
        "createdAt": "2026-05-14T10:02:11.000Z",
        "updatedAt": "2026-06-01T08:30:45.000Z"
      }
    ]
  },
  "meta": { "requestId": "req_01j9x3a8kd", "cursor": null }
}
```

`GET /v1/organizations/{id}/billing/summary` bundles the same entitlements with the customer, active subscription, and plan in one call — the console's billing page reads exactly this.

## Multi-workspace billing

Accounts on plans with `feature.multi_org` can own several workspaces under a single subscription:

- **The first workspace is the billing parent.** It holds the billing customer and the subscription — there is no separate "billing account" entity. Standalone workspaces are their own parent.
- **Child workspaces inherit by fan-out.** When a child is created (or the parent's plan changes), the parent's plan entitlements are copied into the child's own per-workspace rows and re-synced on upgrade, downgrade, or cancel. Entitlement checks always read the workspace's *own* rows, so gating is identical for parents, children, and standalone workspaces.
- **Per-workspace limits apply to each workspace.** `limit.projects`, `limit.members`, and the other per-workspace keys apply to every workspace the account owns; only `limit.organizations` is account-level and caps how many workspaces the account may create.
- **Billing reads resolve to the parent.** Invoices, the subscription, checkout, and the portal for a child workspace resolve to its billing parent — you manage one subscription for the whole account.

Multi-workspace ownership unlocks at **Business** (up to 5 workspaces); Enterprise is unlimited. On Free and Pro, `limit.organizations` is 1, so creating a second workspace prompts an upgrade.

## Related

- [Checkout, invoices & the billing portal](/platform/billing/checkout-and-portal)
- [Usage & quotas](/platform/metering/usage-and-quotas)
- [Billing API reference](/api/resources/billing)
- [Workspaces](/platform/workspaces/organizations)
