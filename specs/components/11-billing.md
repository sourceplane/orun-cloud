# Billing

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- `apps/billing-worker`

Primary dependencies:

- `specs/core/contracts/event-envelope.schema.yaml`
- `specs/components/04-organizations-membership.md`
- `specs/components/10-metering.md`
- `specs/components/03-policy-authorization.md`

Platform dependencies:

- Workers
- Hyperdrive binding to primary Supabase Postgres
- Supabase Postgres for billing-owned relational state
- Queues
- Secrets Store for provider credentials

## Intent

Own organization-level plans, subscriptions, entitlements, invoice state, trials, cancellation, billing portal access, and payment-provider integration behind a starter contract.

## Scope

- plan definitions
- billing customer lifecycle
- subscription lifecycle
- entitlement calculation
- invoice and payment state mirror
- trial, cancellation, upgrade, and downgrade flows
- billing portal session creation
- provider webhook handling

## Out Of Scope

- raw usage aggregation
- general-purpose notification rendering
- org membership management

## Hard Contracts To Honor

- Event envelope in `specs/core/contracts/event-envelope.schema.yaml`
- Metering-first dependency rule in `specs/components/10-metering.md`

## Required Capabilities

### Public/Internal Methods

- `listPlans`
- `getBillingCustomer`
- `createBillingCustomer`
- `createSubscription`
- `changeSubscription`
- `cancelSubscription`
- `createBillingPortalSession`
- `getBillingSummary`
- `listInvoices`
- `getEntitlements`
- `handleProviderWebhook`

### Events

- `subscription.created`
- `subscription.updated`
- `subscription.canceled`
- `invoice.generated`
- `invoice.paid`
- `payment.failed`
- `entitlements.updated`

### Billing Rules

- Billing must consume normalized metering outputs, not raw domain events.
- Entitlements must be queryable by policy and product surfaces.
- Organization is the V1 billing customer boundary; per-project billing is a future extension.
- Project creation and expensive operations may be blocked by plan limits or quota facts.
- Provider-specific fields must stay behind an adapter or mapping layer.

## Data Ownership

This component owns:

- plans
- billing customers
- subscriptions
- entitlements
- invoices
- payment events mirrored into platform state

## Agent Freedom

- The agent may start with manual plans plus a provider adapter seam if payment integration is staged.
- Stripe or another payment provider may be used, but the billing Worker remains the system contract.
- Billing portal redirects are acceptable if represented through the public API.

## Acceptance Criteria

- Plan state and entitlements can be queried from the public API.
- Usage-backed billing inputs come only from metering outputs.
- Changing a subscription updates entitlement checks without hardcoded UI branching.

## Extraction Seam

The billing Worker is the starter contract. The payment processor is an adapter behind it, not the source of truth for product entitlement decisions.
