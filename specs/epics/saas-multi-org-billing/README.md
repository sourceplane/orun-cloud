# Epic: saas-multi-org-billing

**A Datadog-style multi-organization model.** The default stays a single
organization that *is* its own billing entity (exactly today's behavior). Owning
**more than one organization is a purchasable capability** — unlocked by a plan
entitlement — and when unlocked, every organization a customer owns **bills
through their default (parent) organization**. Building this as a *lazy,
additive* evolution means single-org customers never see the machinery and no
existing billing row is migrated.

## Status

| Field | Value |
|-------|-------|
| Status | **In progress** — MO1 (schema seam + flat-tier catalog/entitlements, #253 + #257) and sub-epic BP0 (#254) shipped, all dormant; MO2+ and BP1 gated on Polar creds |
| Cluster | **B** (billing platform — extends B6 billing UX + B11 entitlements into multi-tenant ownership) |
| Owner(s) | `apps/membership-worker` + `apps/billing-worker` + `packages/db` + `apps/web-console-next` (+ `packages/contracts`/`sdk`) |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `core/domain-model.md`, `core/constitution.md`, `components/04-organizations-membership.md`, `components/11-billing.md`, `packages/db/.../110_billing_foundation` |
| Decisions locked | Structural: (1) single org is the default and unchanged; (2) the **first/default org is the billing parent**; (3) multi-org is gated by a **plan entitlement** (`feature.multi_org` + `limit.organizations`), not a config flag; (4) **entitlements stay materialized per-org** — the `check-entitlement` seam and every gating caller are untouched; (5) the payment provider stays behind the billing-worker adapter. Product (D1–D5, 2026-06-08): **Polar** (Merchant of Record) · **self-serve checkout** · **per-org inherited limits** · **grandfather + block-new** on downgrade · **flat tiers** (Free/Pro/Business/Enterprise — catalog in `design.md` §3, multi-org unlocks at Business). |
| Gate | All product decisions resolved; the only remaining blocker for paid multi-org (MO2+) is **Polar credentials** (per env) — see `risks-and-open-questions.md`. MO1 + sub-epic BP0 need nothing. |

## Thesis

Today **Organization = the billing boundary** (`core/domain-model.md`), and the
billing context is already org-scoped end to end. Rather than restructure that
into a mandatory "billing account" tier up front (which would tax every billing,
audit, and membership path forever), we follow Datadog: **start single-org, add a
parent only when a customer buys multi-org.** Mechanically this is one nullable
self-reference on `organizations` plus a fan-out step — because entitlements are
already materialized per-org, *promotion to multi-org never touches the hot read
path or any gate*. The purchased plan is the trigger; the default org is the
payer; child orgs roll their usage up to it.

## How it maps to Datadog (the reference)

| Datadog | Here |
|---------|------|
| Sign up as one org; no billing-account concept exposed | The personal org auto-created on first login *is* the billing entity (unchanged) |
| Multi-org is opt-in, enabled when you need it | Multi-org is unlocked by a **plan entitlement** (`feature.multi_org`) on purchase |
| Child org **inherits the parent's plan**, joins the **parent's billing** | Child org's entitlements are **fanned out from the parent's subscription**; billing resolves to the parent |
| Usage **aggregates to the parent**; per-child attribution view | `metering` rollups **aggregate to the parent**; console shows "Overall vs Individual organizations" |

## Read order

1. `README.md` (this file) — status + milestones-at-a-glance.
2. `design.md` — the lazy-promotion architecture, resolution seam, entitlement fan-out, migration story.
3. `implementation-plan.md` — MO1–MO6, each with "done when".
4. `risks-and-open-questions.md` — the product/human-gated decisions that block paid multi-org.
5. `sub-epics/billing-provider-abstraction/` — the pluggable payment provider (Polar first, Stripe/others later) this epic bills through.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| MO1 | Schema + resolution seam (`parent_org_id`, `effectiveBillingOrg`) + multi-org entitlements in the plan catalog — **no behavior change** | ✅ Shipped (#253 seam + #257 catalog) |
| MO2 | Purchase-gated org creation (`feature.multi_org` + `limit.organizations`) with designed upgrade UX (reuse U7) | ✅ Shipped (#265 gate + #266 console) |
| MO3 | Child-org lifecycle + entitlement fan-out (attach/detach; re-fan-out on plan change/cancel) | ✅ Shipped (#268–#270; freeze-on-cancel flag-only, enforcement deferred) |
| MO4 | Consolidated billing + usage rollup at the parent (summary/invoices/usage) | ◐ Billing reads shipped (#272); usage rollup pending |
| MO5 | Console: account-grouped org switcher, gated "create organization", account billing on the default org | 🗓️ Planned |
| MO6 | Migration + reversibility (single org → parent on first child; detach → standalone) | 🗓️ Planned |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The parent/child org tenancy seam, the purchase gate, per-org entitlement fan-out, consolidated billing + usage rollup, the console surfaces for it | The payment provider itself (→ `sub-epics/billing-provider-abstraction/`); pooled cross-org quota *enforcement* (a risk-gated variant, not the default); SSO/SCIM per child (→ `saas-baseline` B10); cross-org RBAC roles (a `components/04` follow-up) |

## Relationship to existing work

- Realizes the "future extension" flagged in `components/11-billing.md` ("per-project / per-org billing is a future extension") and `core/domain-model.md` ("Billing customer state belongs to an organization … in V1").
- Extends `saas-baseline` **B6** (billing UX) and **B11** (provider-neutral entitlements) — does **not** replace them.
- Reuses `saas-console-ux` **U7** (designed `412 precondition_failed` upgrade UX) for the org-creation gate.
