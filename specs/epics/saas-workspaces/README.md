# Epic: saas-workspaces

**Rebrand the sub-organization to a "Workspace", and present the account as one
account that contains Workspaces.** `saas-multi-org-billing` shipped the parent/
child org primitive; this epic gives it a buyer-credible vocabulary. A customer's
parent org is the **Account** (the tenant + billing entity); every org under it —
**including the parent's own direct workspace** — is a **Workspace**. This is a
**presentation-layer + public-API-aliasing** change: the data model stays
`membership.organizations` + `parent_org_id`, `org_id`-everywhere is untouched,
and `/v1/organizations/*` keeps working. We add `/v1/workspaces/*` aliases and
console/SDK/CLI vocabulary on top.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — not started; depends on the shipped `saas-multi-org-billing` MO1 seam |
| Cluster | **WS** (workspaces vocabulary — presentation + API-alias layer over **MO** `saas-multi-org-billing`) |
| Owner(s) | `apps/web-console-next` + `apps/api-edge` + `packages/contracts`/`sdk`/`cli` (+ docs) |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `saas-multi-org-billing/design.md` (parent/child orgs, `effectiveBillingOrg`); `apps/web-console-next/src/components/shell/use-effective-org.ts` + scope-switcher (the chrome this rebrand re-labels); `apps/api-edge/src/org-facade.ts` (the routes this aliases) |
| Decisions locked | (1) The noun is **"Workspace"** for a unit and **"Account"** for the tenant/parent — chosen because "Workspace" has **no** collision in the product domain, whereas **"Product"** collides with the Polar *product* (billing SKU) and **"Project"** is the existing sub-unit; (2) **relabel, do not remodel** — no new `products`/`workspaces` entity; a Workspace *is* an `organizations` row; (3) depth = **label + public API aliasing** (not label-only, not a full model rename) — `/v1/workspaces/*` aliases `/v1/organizations/*`, response shapes gain `workspaceId` alongside `orgId`, internal `org_id` is untouched; (4) the **parent is surfaced as both the Account and one selectable Workspace** (its own direct work), as a synthetic UI affordance — no schema change. |
| Gate | Human-independent. The only open items are vocabulary lock confirmation (Workspace/Account) and the public-deprecation policy for the `organization` term — registered in `risks-and-open-questions.md`. |

## Thesis

The platform already has the right *structure* — a parent org that owns billing
and contains child orgs (`saas-multi-org-billing`). What it lacks is *language* a
buyer recognizes. "Organization" and "sub-organization" describe the plumbing,
not the product. The Datadog/Vercel/Slack idiom is an **Account** that contains
**Workspaces**. Adopting that name makes the multi-org story — and the shared
GitHub integration (`saas-integration-tenancy`) — legible: *the account installs
GitHub once; its workspaces consume it.*

Crucially this is a **rename, not a remodel**. Renaming a tenancy primitive at the
*model* layer would fight `org_id`-everywhere across every schema, route, policy
scope, and audit envelope — an enormous migration for zero functional gain.
Instead we treat "Workspace"/"Account" as the **public vocabulary** over the
unchanged `organizations` table: the console and SDK/CLI speak Workspaces, the
edge serves `/v1/workspaces/*` as aliases of `/v1/organizations/*`, and the
internal model never moves.

## How it maps to the references

| Reference | Account (tenant) | Unit |
|-----------|------------------|------|
| Datadog | Account / Parent organization | Organization |
| Vercel | Team | Project |
| Slack | Enterprise Grid org | Workspace |
| **Here** | **Account** (= parent / standalone `organizations` row) | **Workspace** (= each `organizations` row in the account, incl. the parent's own) |

Avoided on purpose: **"Product"** (collides with the Polar *product* SKU across
`apps/billing-worker/src/billing-provider/*` and the plan catalog) and reusing
**"Project"** (the existing `project_id` sub-unit under every org).

## Read order

1. `README.md` (this file) — status + thesis + milestones-at-a-glance.
2. `design.md` — the glossary, the relabel-not-remodel rule, the API-aliasing
   strategy, the parent-as-workspace affordance, back-compat + deprecation.
3. `implementation-plan.md` — WS1–WS5, each with "done when".
4. `risks-and-open-questions.md` — noun lock, aliasing depth, audit/event
   terminology, dual-route maintenance.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| WS1 | Glossary + vocabulary decision (Account/Workspace) recorded in `core/`; no code/API change | 🗓️ Planned |
| WS2 | Public API aliasing: `/v1/workspaces/*` routes alias `/v1/organizations/*` at the edge; contracts add `workspaceId` aliases alongside `orgId`; old routes unchanged | 🗓️ Planned |
| WS3 | SDK/CLI: expose a `workspaces` surface aliasing `organizations` across **both** CLIs (`@saas/cli` + the customer-facing Go `orun` CLI, incl. its `intent.yaml execution.state.org` claim — coordinate with `saas-orun-platform` DV5); deprecation notes; both compile | 🗓️ Planned |
| WS4 | Console rebrand: "Account" header + "Workspace" switcher (reuse `use-effective-org` + scope-switcher); parent surfaced as a selectable Workspace | 🗓️ Planned |
| WS5 | Docs + deprecation policy: public docs say Workspace/Account; decide whether `organization` terms in audit events/analytics are aliased or left internal | 🗓️ Planned |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The Account/Workspace glossary; `/v1/workspaces/*` public-API aliases; contract/SDK/CLI vocabulary; the console relabel + parent-as-workspace affordance; the docs/deprecation policy | Any change to the data model (`organizations`, `parent_org_id`, `org_id`) — explicitly **not** a new entity; the integration tenancy *mechanism* (→ `saas-integration-tenancy`); the billing parent/child primitive itself (→ `saas-multi-org-billing`); renaming `project`/`environment`; cross-org RBAC |

## Relationship to existing work

- **`saas-multi-org-billing` (MO)**: provides the structure (parent/child orgs,
  `effectiveBillingOrg`, scope-switcher, fan-out). This epic renames its surface;
  it changes **no** billing behavior.
- **`saas-integration-tenancy` (IT)**: the consumer of the new vocabulary — "the
  Account's GitHub connection; each Workspace links its own repos." Orthogonal in
  mechanism; landing order is free.
- **`saas-console-ux` (U)**: the design system + scope-switcher this rebrand
  relabels; reuses U7 patterns, adds no new tenancy UI primitive.
- **`saas-product-experience` (PX)**: the rename-lifecycle and console-truth work
  this aligns with — public vocabulary should be consistent across surfaces.
