# Epic: saas-teams

**Add Teams as account-owned _principals_ — named groups of subjects you grant roles
to — so an Account can manage access across all its Workspaces, with new Workspaces
inheriting team access automatically.** A Team is **not** a tenancy level and **not** a
container for resources; it is just another thing a role can be granted to, alongside a
user. That keeps Teams fully **additive at Stage 1**: two new tables, one new
`subject_type`, and a fact-expansion step at authorization time — **no policy-engine
rewrite and no tenancy remodel.**

This is the **principal-group** meaning of "team" (à la GitHub org teams), deliberately
*not* the hierarchy-level meaning (Account→Team→Workspace), which would deepen the tree
and belongs to `saas-workspace-id` **Stage 2**.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — authored, not ready to build; depends on `saas-workspace-id` WID6 (account RBAC). Open items in `risks-and-open-questions.md`. |
| Cluster | **TM** (teams — account-owned principals over **WID** account RBAC) |
| Owner(s) | `packages/db` (schema) · `apps/membership-worker` (teams + authz context assembly) · `packages/policy-engine` (unchanged — consumes expanded facts) · `apps/api-edge` + `packages/contracts`/`sdk`/`cli` · `apps/web-console-next` |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `saas-workspace-id` **WID6** (`scope_kind='account'` + the policy cascade) — the authority model Teams are granted within; `membership.role_assignments` (`scope_kind`/`scope_ref`, `subject_id TEXT` + `subject_type`, `packages/db/src/migrations/020_membership_core/up.sql`); the policy engine's union-of-permissions evaluation (`packages/policy-engine/src/index.ts`); `effectiveBillingOrgId` (account ownership); the PERF2 actor/authz cache (`apps/api-edge/src/resolve-actor.ts` / `actor-cache.ts`) |
| Decisions locked | (1) Teams are **account-owned principals**, grantable at account/workspace/project scope — chosen over workspace-local-only (which account-owned subsumes) and over a hierarchy level (deepens the tree → Stage 2); (2) **reuse `role_assignments`** with a new `subject_type='team'` — no separate team-grants table, so the policy engine stays agnostic; (3) **expand teams into facts at authorization-context-assembly time** (`membership-worker`), leaving the policy engine a pure function over the merged fact set; (4) **permissions are a union** (most-permissive-wins) — consistent with the existing allow-only engine; (5) **flat teams** (no nesting) and **no resources on teams** at Stage 1. |
| Gate | **Human-dependent.** Confirm the open items in `risks-and-open-questions.md`: members-include-service-principals (T2), the cache-invalidation strategy (T5), and the id format (T1). Hard prerequisite: `saas-workspace-id` WID6 must land first. |

## Thesis

The account layer (`saas-workspace-id`) gives an Account the *authority* to manage its
Workspaces. Teams give that authority **leverage**: instead of granting each user a
role on each workspace, you grant a *team* a role once, and membership cascades. The
killer property falls straight out of account ownership + resolve-up authorization:

> Grant `Team: Platform-Admins` the `admin` role at **account scope**, and **every
> existing and future Workspace** in the account is covered — a new workspace created
> tomorrow needs zero backfill, because the account-scope team grant is resolved when
> the new workspace is authorized.

Crucially this is the **lowest-cost** way to ship teams: a Team is a *principal*, so it
slots into the grant machinery already in place. The only behavioral change is that the
actor's authorization context now includes the grants reaching them *through* their
teams — and the policy engine, which already unions permissions over a list of facts,
neither knows nor cares where a fact came from.

## How it maps to the references

| Reference | "Team" meaning | Here |
|-----------|----------------|------|
| GitHub org teams | principal-group granted repo access; membership cascades | ✅ **this epic** (Stage 1) |
| Slack user groups | principal-group for mentions/access | ✅ principal-group |
| AWS OUs / GCP folders | hierarchy level containing accounts/projects | ❌ **not** this epic → `saas-workspace-id` Stage 2 |

## Read order

1. `README.md` (this file) — status + thesis + the principal-not-level distinction.
2. `design.md` — the data model (2 tables + `subject_type='team'`), the
   authorization-context expansion, the inheritance payoff, team management + RBAC, and
   the explicit Stage-1 scope lines.
3. `implementation-plan.md` — TM1–TM5, each with "done when".
4. `risks-and-open-questions.md` — the T-decisions, the cache-staleness risk, and the
   WID6 dependency.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| TM1 | Data model: `membership.teams` + `membership.team_members`; `team_…` public id | Draft |
| TM2 | Grants: allow `subject_type='team'` in `role_assignments`; grant/revoke APIs at account/workspace/project scope | Draft |
| TM3 | Authorization expansion: `membership-worker` context assembly expands the actor's teams into facts; policy engine unchanged; union semantics | Draft |
| TM4 | Management surfaces: account RBAC perms (`team.*`) + console/SDK/CLI team CRUD + membership + grants | Draft |
| TM5 | Cache invalidation: bust/short-TTL the PERF2 actor/authz cache on team-membership / team-grant change | Draft |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| Account-owned Teams (`teams` + `team_members`); `subject_type='team'` grants via the existing `role_assignments`; authz-context fact expansion; team CRUD + membership + grant surfaces; account-RBAC permissions for managing teams; PERF2 cache invalidation | **Nested teams** (teams-in-teams) and **teams-as-hierarchy-level** (Account→Team→Workspace) — both deferred (Stage 2 / future); **resources owned by a team** (resources stay on workspace/project); the account-RBAC primitive itself (→ `saas-workspace-id` WID6); deny/negative permissions (the engine is allow-only) |

## Relationship to existing work

- **`saas-workspace-id` (WID)**: hard upstream — Teams are granted within the
  `scope_kind='account'` RBAC + cascade delivered by WID6, and "account-owned" means
  owned by the Account that `accountId`/`effectiveBillingOrgId` identifies.
- **`saas-multi-org-billing` (MO)**: supplies `parent_org_id`/`effectiveBillingOrg`,
  the account boundary a Team belongs to and inherits across.
- **`saas-workspaces` (WS)**: supplies the Account/Workspace vocabulary the team
  surfaces speak ("a Team belongs to the Account; it is granted on Workspaces").
- **`saas-baseline` (B) / RBAC**: extends the existing role/permission catalog and the
  `role_assignments` + policy-engine model rather than introducing a parallel ACL.
