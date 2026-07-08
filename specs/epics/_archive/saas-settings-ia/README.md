# Epic: saas-settings-ia

**Three scoped settings homes, one People & Access surface** — the console
**information-architecture** seam. The platform already has three real scopes
(**You → Account → Workspace**) and a shipped Account/Workspace vocabulary,
teams-as-principals, and account-cascade RBAC — but the console still presents
them as one `/settings` bucket with five scope-mixed groups, and scatters
members, invitations, roles, teams, and access across all of them. This epic
consolidates that IA. **Relabel and regroup, not remodel.**

## Status

| Field | Value |
|-------|-------|
| Status | **✅ Shipped** (SI1–SI5 merged; epic closed & archived) |
| Cluster | **SI** (SI1–SI5) |
| Owner(s) | `apps/web-console-next` (shell nav + settings routes); read-only facades in `packages/contracts` for the roles matrix |
| Target branch | `main` |
| Builds on | `components/12-web-console.md`; **U** (`saas-console-ux`, shipped shell) · **WID4/WID5** (switcher Account/Workspace badge, shipped) · **WID6** (`scope_kind='account'` RBAC cascade, shipped) · **TM/TF** (teams principal + entity) · **TH1** (`teams-hub` Account Hub surface — coordinated) |
| Decisions locked | See § Decisions |

## Thesis

The data model is already right: `Account` and `Workspace` are two labels over
one `membership.organizations` row (`parent_org_id ?? id`,
`specs/core/vocabulary.md`), and a `Team` is an account-owned principal that
spans workspaces — orthogonal to the tree, never a level in it. The **console
IA does not yet mirror that model.** Today:

- **`/settings`** is a single surface with five groups — Workspace, Account,
  Billing, Notifications, Developer — that mix three scopes
  (`components/shell/settings-nav.ts`).
- The **Account** hub is nested *inside* a child workspace's settings
  (`/orgs/:slug/settings/account/*`) — the parent rendered as a subsection of
  its child.
- **Members** means three near-identical destinations (workspace members,
  account members, team members); **Invitations** is split from Members;
  **Roles** and **Access** have no coherent home; role editing exists in the API
  (`update-member-role`) but isn't exposed in the UI.
- **Billing** lives at workspace scope but always bills at
  `effectiveBillingOrgId` (the account); **Sessions & devices** and a personal
  **Notifications** (email prefs) sit under org-scoped groups even though they
  belong to the human.

This epic makes the IA match the model: **settings follow the scope switcher**
(three doorways — You via the identity chip, Account via the Account chip,
Workspace via the workspace chip), members/invitations/teams/roles/access
collapse into **one "People & Access" tabbed surface per scope**, and the four
mis-scoped surfaces are re-filed. No new tables, no tenancy change, `org_id`
preserved end to end.

## Decisions

- **D1 — Relabel & regroup only.** No new entity, no schema change; the epic
  edits console navigation models, routes, and redirects. Mirrors the WS/WID/TM
  discipline.
- **D2 — Settings follow the switcher.** Scope is chosen by the top-of-shell
  switcher; the matching Settings opens for it. **You** (personal, actor-scoped)
  hangs off the identity chip and is reachable regardless of org; **Account** and
  **Workspace** hang off the tenancy switcher. No duplicated "settings tab" per
  scope — one routing rule.
- **D3 — An invitation is a member who hasn't accepted.** Invitations are the
  **Pending** tab of the roster, not a sibling destination
  (Linear/Vercel/GitHub/Stripe pattern).
- **D4 — The Account doorway hosts the `teams-hub` Account Hub.** SI owns the
  **nav model + routing** that places the account surface at a top-level
  doorway; **TH1** owns the account-surface **pages** (members roster, workspace
  list, cross-workspace reads). Where TH pages don't exist yet, SI lifts the
  current `settings/account/*` pages up unchanged.
- **D5 — End the "account" word-collision.** The personal area is renamed from
  `/account` to `/you` ("Your settings"); "Account" is reserved for the tenant.
  Legacy `/account*` routes redirect.

## Read order

1. `README.md` (this file) — thesis, decisions, milestones.
2. `design.md` — the scope model, the three doorways, the People & Access
   surface, the re-filing map, and the exact nav-model changes (real symbols).
3. `implementation-plan.md` — SI1–SI5 with "done when".
4. `risks-and-open-questions.md` — the seams and the open calls.

## Milestones at a glance

| ID | Milestone | Risk | Status | PR |
|----|-----------|------|--------|----|
| SI1 | Re-file the mis-scoped surfaces (Billing → Account; Sessions → personal area; disambiguate the two Notifications; Config already de-orphaned). Pure nav + redirects. | Low | ✅ Shipped | #365 |
| SI2 | Scope doorways — settings follow the switcher: Account settings off the Account chip, Workspace off the workspace chip, personal off the identity chip. Adds `buildAccountNav`/`buildPersonalNav`. | Medium | ✅ Shipped | #366 |
| SI3 | People & Access — one tabbed surface (Members · Pending · Roles · Access); invitations become Pending; inline role editing; access provenance on the Access tab. | Medium | ✅ Shipped | #367 |
| SI4 | Roles as a destination — a permission matrix mirroring the policy-engine role catalog; the seam custom roles (TG) plug into later. Read-only. | Low | ✅ Shipped | #368 |
| SI5 | Naming — `/account` → `/you`, resolving the tenant/person "account" collision; every entry point + Cmd-K updated. | Low | ✅ Shipped | #369 |

> As-built (including deviations): see [`IMPLEMENTATION-STATUS.md`](./IMPLEMENTATION-STATUS.md).

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| Console nav models (`settings-nav.ts`, `nav-items.ts`, a new `account-nav.ts`), scope-doorway routing, the People & Access tabbed surface, wiring inline role editing to the shipped `update-member-role` API, a read-only Roles matrix from the shipped role catalogs, naming/copy, and redirect shims for every moved route | Any tenancy remodel / new tables (WID Stage 2); the account-surface **pages** + cross-workspace read layer (owned by **TH**); custom-roles engine and team-scoped restriction/ABAC (**TG**); SSO/SCIM (**B10**/**TG**); the notification-preferences backend (**PX3**/**B2**); org/project/env rename lifecycle (**PX4**) |

## Relationship to existing work

- **`saas-console-ux` (U)** — SI extends the shipped shell (URL-driven scope,
  Cmd-K, design system). It is the IA/regroup layer *over* U's primitives, not a
  new design system.
- **`teams-hub` (TH)** — the keystone dependency for SI2's Account doorway. TH
  builds the account-surface pages; SI gives them a top-level front door and
  routes the switcher to them. The two are designed to land together.
- **`saas-teams` (TM) / `teams-foundation` (TF)** — supply the Team principal +
  entity that SI3's Teams tab renders; SI adds no team backend.
- **`saas-workspace-id` (WID) / `saas-workspaces` (WS)** — supply the
  Account/Workspace `kind`/`accountId` the switcher already badges (WID4/WID5)
  and the account-cascade RBAC (WID6) SI3's provenance column reads.
- **`saas-product-experience` (PX)** — PX3 (notification-preferences backend)
  unblocks the *content* of the personal Notifications page SI1 re-homes; SI only
  moves where it lives.
