# Epic: teams-hub (TH)

**Give the Team a home — the *team page* ("how are we doing?") — and, to host it, thicken
the account *surface* (not the tree) into an Account Hub.** A Team is account-owned and
spans Workspaces, but today the account has almost no console home, so the one object that
naturally lives above workspaces has nowhere to live. TH builds the surface and the page,
plus the **cross-workspace aggregation** read layer they require. Part of the
[`teams-platform`](../teams-platform/) program. **Plane: Hub + account surface.**

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — depends on `teams-foundation` **TF** (entity) and `teams-ownership` **TO** (owned-services resolution + coverage). Introduces the first substantial **account-level console surface**. |
| Cluster | **TH** (teams-hub — account surface + team page) |
| Owner(s) | `apps/web-console-next` (Account Hub + Team Page) · `apps/api-edge` + `apps/membership-worker` (account-level read aggregation) · `apps/state-worker` (cross-workspace catalog/run reads) · `packages/contracts`/`sdk` |
| Builds on | `teams-ownership` **TO** (owner→team + owned-entity coverage); `teams-foundation` **TF** (team profile + members + provenance); `saas-workspace-id` **WID** (account/`accountId`/`kind`, `list-account-workspaces`/IT12 picker seam, account cascade); `saas-service-catalog` (deployments/activity tabs SC2/SC3) |
| Decisions locked | (1) **Thicken the account surface, do NOT deepen the tree** — no `Account → Team → Workspace` level (that stays WID Stage 2); the Account Hub is a *surface* over the existing `parent_org_id` reference; (2) the Team Page aggregates **across all Workspaces under the account** (a team's services are wherever they live); (3) cross-workspace reads **fan out over the account's Workspace set** (per-org indexes) — no new denormalized cross-workspace store; (4) the Account Hub is where account-members, account-roles (WID6 grant/list/revoke), teams, and the workspace list finally get a UI. |
| Gate | Confirm TH-A (account-hub IA / route), TH-B (cross-workspace read fan-out budget), TH-C (workspace-set visibility — does a team page show services in workspaces the viewer can't access?). See `risks-and-open-questions.md`. |

## Thesis

Datadog's team page is where Teams stops being plumbing and becomes a product: *our
services, their health, our recent deploys, our on-call, our people* — one page. That page
needs three things this repo lacks: **(a)** a place to live (the account has no surface),
**(b)** the team's owned services (from **TO**), and **(c)** the ability to read across
Workspaces (catalog + runs are per-org today). TH delivers all three. The strategic point:
**Teams is the feature that finally justifies building the account surface** WID6/WS left
deliberately thin — account-members, account-role management (WID6 shipped grant-only and
deferred list/revoke), the workspace roster, and now teams all get a home at once.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| TH1 | **Account Hub surface**: an account-level console area (overview · workspaces · members · account-roles · teams · usage rollup); closes WID6's deferred account-role **list/revoke** | Draft |
| TH2 | **Cross-workspace read layer**: account-scoped aggregation that fans out over the account's Workspace set (catalog entities + runs), with a query budget | Draft |
| TH3 | **Team Page**: identity + members + **owned services across workspaces** + ownership coverage (from TO5) | Draft |
| TH4 | **Team activity/deploy rollup**: the owned services' recent runs/deploys/health on the team page (rides SC2/SC3 + the run `component` ref) | Draft |
| TH5 | **Multi-workspace grant management**: from the account, grant a team a role on a **selected set** of workspaces (the "add people to many chosen workspaces" action) via the IT12 picker | Draft |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The Account Hub surface, account-member + account-role management UI (incl. WID6 list/revoke), the Team Page, cross-workspace read aggregation, team activity rollup, multi-workspace team-grant management | Making `accounts` a first-class entity / a hierarchy level (stays **WID Stage 2**); a new cross-workspace denormalized store (fan-out over per-org indexes instead); notification routing (→ **TC**); the ownership resolver itself (→ **TO**) |

## Read order

1. `README.md` — thicken-the-surface-not-the-tree thesis + the team-page composition.
2. `design.md` — the account-hub IA, the cross-workspace fan-out, the team-page data.
3. `implementation-plan.md` — TH1–TH5 with "done when".
4. `risks-and-open-questions.md` — hub IA, fan-out budget, cross-workspace visibility.
