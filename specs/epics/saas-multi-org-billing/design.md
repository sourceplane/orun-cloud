# saas-multi-org-billing — Design

Status: Design locked for MO1; MO2+ gated on `risks-and-open-questions.md`.

## 1. Starting point (what already holds)

- `core/domain-model.md`: **Organization is the tenant, billing, membership, and
  audit boundary.** A user may belong to many orgs; a personal org is
  auto-created on first login.
- Billing is org-scoped end to end: `billing.billing_customers` has
  `uq_billing_customer_org` (one customer per org); `subscriptions`,
  `entitlements`, `invoices` are all keyed by `org_id`.
- `billing-worker` materializes a plan's entitlement set into
  `billing.entitlements` `(org_id, entitlement_key)` (see
  `handlers/assign-plan.ts`), and `check-entitlement(orgId, key)` reads those
  rows directly — the PERF-tuned hot path consumed by `projects-worker` and
  `membership-worker`.
- Org creation (`membership-worker` `create-organization`) is currently **not**
  entitlement-gated — it is the bootstrap.

The design principle: **change who pays and how orgs relate, without changing how
entitlements are read or enforced.**

## 2. The model: lazy parent/child, entitlement-triggered

```
Customer (a person or company)
  └─ Organization  ← default/first org = the BILLING PARENT (holds the subscription)
       ├─ Organization (child)   ┐ created only when the parent's plan grants
       ├─ Organization (child)   │ feature.multi_org + limit.organizations
       └─ Organization (child)   ┘ each child rolls usage/billing up to the parent
            └─ Project → Environment   (unchanged within every org)
```

- **Default is single org.** With no children and no parent, an org behaves
  exactly as today. The machinery is invisible.
- **The first/default org is the parent.** It owns the billing customer +
  subscription. There is no separate "billing account" entity — the parent *is*
  an organization (mirrors Datadog making the existing org the parent).
- **Multi-org is purchased, not configured.** A plan grants
  `feature.multi_org = true` and `limit.organizations = N`. The free/default plan
  grants neither (effectively `N = 1`).
- **Children inherit by fan-out.** A child has its own `org_id`-scoped
  entitlement rows, *copied from the parent's subscription* at attach time and
  re-synced on plan change/cancel. So `check-entitlement` and all gates stay
  byte-for-byte unchanged.

## 3. Schema change (additive, non-breaking)

One nullable self-reference — MO1:

```sql
ALTER TABLE membership.organizations
  ADD COLUMN IF NOT EXISTS parent_org_id TEXT;          -- NULL = standalone/parent
CREATE INDEX IF NOT EXISTS idx_org_parent
  ON membership.organizations (parent_org_id)
  WHERE parent_org_id IS NOT NULL;
```

(Exact schema namespace per the membership migration; verify against
`packages/db/.../020_membership_core`.) No existing row changes — every org is
`parent_org_id = NULL` (standalone) on day one. No billing table changes at all:
the parent keeps the `org_id`-scoped customer/subscription it already had.

### Plan catalog (D5 — flat tiers, decided 2026-06-08)

The decided catalog for `billing-worker/src/plan-catalog.ts`. Two new entitlement
keys (`feature.multi_org`, `limit.organizations`) join the existing
`limit.projects` / `limit.environments` / `limit.members` / `feature.custom_domains`.
Per D3, every per-org limit applies to **each** org an account owns; only
`limit.organizations` is account-level. `null` = unlimited.

| Plan (`code`) | Price/mo | Polar product | `limit.organizations` | `feature.multi_org` | `limit.projects` (per org) | `limit.environments` (per project) | `limit.members` (per org) | `feature.custom_domains` |
|---|---|---|---|---|---|---|---|---|
| Free (`free`) | $0 | — (no product) | 1 | false | 3 | 3 †| 5 | false |
| Pro (`pro`) | $20 | fixed-price | 1 | false | 25 | 3 | 20 | true |
| Business (`business`) | $99 | fixed-price | 5 | **true** | 100 | 5 | 50 | true |
| Enterprise (`enterprise`) | custom | — (sales; no self-serve product) | `null` (∞) | **true** | `null` (∞) | `null` (∞) | `null` (∞) | true |

- **Multi-org unlocks at Business** (`feature.multi_org=true`, up to 5 orgs);
  Enterprise is unlimited and sold via "contact sales", not self-serve checkout.
- **Free/Pro are single-org** (`limit.organizations=1`) so the org-creation gate
  (MO2) blocks a second org with an upgrade prompt to Business.
- **MO1 reconciliation (as-built):** the catalog shipped in `plan-catalog.ts`
  (PR for the MO1 catalog half). `free`'s `limit.environments` is kept at **3**
  (†) — its current live value — rather than the 2 first proposed here, because
  `free` is in use by every bootstrapped org and the no-regress rule forbids
  lowering an in-use plan's limits (apply the D4 grandfather principle — see
  risks). All other numbers are as listed.

## 4. The resolution seam

A single helper centralizes "who is the billing entity for this org":

```
effectiveBillingOrg(org) = org.parent_org_id ?? org.id
```

- **Billing reads** (`getBillingSummary`, `listInvoices`, customer/subscription,
  checkout/portal) resolve against `effectiveBillingOrg`.
- **Entitlement decisions** keep reading the org's *own* `(org_id, key)` rows —
  unchanged — because fan-out (next section) keeps them in sync. This preserves
  the hot path and means **no gating caller is modified.**

## 5. Lifecycle & fan-out (MO3)

- **Create/attach child** (gated, MO2): create a normal org with
  `parent_org_id = <parent>`, then fan out the parent subscription's plan
  entitlements into the child's `(org_id, key)` rows (reuse the existing
  `assign-plan` materialization path, scoped to the child). Child is immediately
  usable with the parent's limits.
- **Plan change on the parent:** re-fan-out to every child (and the parent) so a
  downgrade/upgrade propagates. Emits `entitlements.updated` per org (existing
  event).
- **Cancel/downgrade below multi-org:** children are either frozen or detached to
  the free plan per the policy chosen in risks; `limit.organizations` enforcement
  prevents creating new children once over the new limit (existing-over-limit is
  a grandfathering decision — see risks).
- **Detach (reversibility):** clearing `parent_org_id` turns a child back into a
  standalone org that bills for itself. No data migration; fully reversible.

## 6. Purchase gate on org creation (MO2)

`membership-worker` `create-organization` gains a branch:

1. The **first** org for a user (bootstrap) is always allowed — unchanged.
2. Creating an **additional** org checks, against the billing parent:
   `feature.multi_org` enabled **and** current child count `< limit.organizations`.
   This reuses the existing `check-entitlement` client (same pattern as the
   `limit.members` gate in `membership-worker/src/billing-client.ts`).
3. On deny → `412 precondition_failed` with the standard reason codes
   (`disabled` / `not_configured` / `limit_reached`), rendered by the existing
   **U7** upgrade UX. The CTA points at checkout for a multi-org plan.

## 7. Consolidated billing & usage rollup (MO4)

- **Billing**: one customer/subscription, on the parent. `getBillingSummary` and
  `listInvoices` for any child resolve to the parent (via `effectiveBillingOrg`).
  The payment provider's customer is the **parent org** (`customerExternalId =
  parentOrgId`) — see the provider sub-epic; nothing provider-side is per-child.
- **Usage**: `metering` already produces per-org rollups. The parent's usage view
  **sums its children's rollups**; the console exposes an "Overall vs Individual
  organizations" toggle (Datadog parity). No new metering ownership — a read-time
  aggregation over existing rollups keyed by the parent's child set.

## 8. Migration & compatibility

- **Zero migration of live data.** Every existing org is standalone
  (`parent_org_id NULL`) and keeps its own billing. The feature is dormant until
  a customer buys multi-org.
- **Promotion is an event, not a migration:** an org "becomes a parent" the
  moment it creates its first child. Its existing subscription becomes the account
  subscription with no row rewrite.
- **Backwards-compatible reads:** `effectiveBillingOrg` collapses to `org.id` for
  every standalone org, so all current behavior is preserved bit-for-bit.

## 9. The one architectural decision that changes the build

**Per-org inherited limits (default, recommended) vs pooled quotas.**

- *Per-org inherited* (recommended): each child gets the plan's `limit.projects`,
  `limit.members`, etc. independently; only `limit.organizations` is
  parent-level. Keeps the fast per-org read path; this is what Datadog does for
  entitlements (it pools only usage/billing).
- *Pooled* (e.g. "500 projects shared across all orgs"): requires a live
  cross-org aggregation read at gate time — slower, and it breaks the
  "no change to the check seam" property. Build only if a customer demands it.

This and the other product/credential decisions are tracked in
`risks-and-open-questions.md`; MO1 is safe to build before they are resolved
(it adds only the dormant seam).
