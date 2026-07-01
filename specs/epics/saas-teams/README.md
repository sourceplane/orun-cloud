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
| Status | **Ready** — the hard upstream (`saas-workspace-id` WID6, account RBAC) **shipped**: migration `420_membership_account_rbac`, `ACCOUNT_ROLE_PERMISSIONS` in `packages/policy-engine/src/index.ts`, and the live cascade in `apps/membership-worker/src/handlers/authorization-context.ts`. TM1→TM3 is buildable now. One **soft** dependency remains: WID6 shipped only the account-role *grant* path and deferred **list/revoke** to the admin-portal follow-up — TM4's management surfaces need that plumbing (see `risks-and-open-questions.md`, R-LR). Confirm the remaining open items (T1 id-format, T2 SP-members) before the corresponding milestone. |
| Cluster | **TM** (teams — account-owned principals over **WID** account RBAC) |
| Owner(s) | `packages/db` (schema) · `apps/membership-worker` (teams + authz context assembly) · `packages/policy-engine` (unchanged — consumes expanded facts) · `apps/api-edge` + `packages/contracts`/`sdk`/`cli` · `apps/web-console-next` |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `saas-workspace-id` **WID6** (`scope_kind='account'` + the policy cascade, **shipped**) — the authority model Teams are granted within, plus its `authorization-context.ts` assembly (the exact seam TM3 extends) and its `grant-account-role.ts` handler (the pattern TM2 reuses); `membership.role_assignments` (`scope_kind`/`scope_ref`, `subject_id TEXT` + `subject_type` — note its two CHECK constraints TM2 must widen, `packages/db/src/migrations/020_membership_core/up.sql`); the policy engine's first-allow-wins (⇒ union) evaluation (`packages/policy-engine/src/index.ts`); `effectiveBillingOrgId` (account ownership); `listRoleAssignmentsForSubjects` (batch lookup TM3 uses to expand team grants without an N+1). **Note:** the PERF2 cache (`apps/api-edge/src/resolve-actor.ts` / `actor-cache.ts`) caches only **token→identity** (30s TTL) — it does **not** cache role facts or team membership, so it is *not* a team-invalidation surface (see design §7 / TM5). |
| Decisions locked | (1) Teams are **account-owned principals**, grantable at account/workspace/project scope — chosen over workspace-local-only (which account-owned subsumes) and over a hierarchy level (deepens the tree → Stage 2); (2) **reuse `role_assignments`** with a new `subject_type='team'` — no separate team-grants table, so the policy engine stays agnostic; (3) **expand teams into facts at authorization-context-assembly time** (`membership-worker`), leaving the policy engine a pure function over the merged fact set; (4) **permissions are a union** (most-permissive-wins) — consistent with the existing allow-only engine; (5) **flat teams** (no nesting) and **no resources on teams** at Stage 1. |
| Gate | **Human-dependent.** WID6 has landed, so the *hard* prerequisite is cleared. Remaining gate: confirm the open items in `risks-and-open-questions.md` — members-include-service-principals (T2) and the id format (T1). T5 (cache) is **reframed** from a blocker to a PERF note (the actor cache holds no team data; offboarding is already immediate). Sequence TM4's grant-management UI behind the account-role list/revoke follow-up (R-LR). |

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
3. `implementation-plan.md` — TM1–TM6, each with "done when".
4. `risks-and-open-questions.md` — the T-decisions, the corrected cache premise (T5),
   the account-role list/revoke soft-dependency (R-LR), team-lifecycle cleanup, and the
   (now-cleared) WID6 dependency.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| TM1 | Data model: `membership.teams` + `membership.team_members`; `team_…` public id; widen the two `role_assignments` CHECK constraints for `subject_type='team'` | Draft |
| TM2 | Grants: allow `subject_type='team'` in `role_assignments` (reusing the `grant-account-role.ts` pattern); grant/revoke APIs at account/workspace/project scope; **cascade-revoke team grants on team delete** | Draft |
| TM3 | Authorization expansion: `authorization-context.ts` expands the actor's active teams into facts (direct + account-cascade) via `listRoleAssignmentsForSubjects`; policy engine unchanged; union semantics; **hot-path query budget** (skip when the account has no teams) | Draft |
| TM4 | Management surfaces: account RBAC perms (`team.*`) + console/SDK/CLI team CRUD + membership + grants; **emit `team.*` audit/events** on every mutation (the existing membership-handler pattern; also backfills the `grant-account-role` audit gap) | Draft |
| TM5 | ~~Cache invalidation~~ → **PERF note (not a blocker).** The PERF2 actor cache holds only token→identity, so team changes already take effect on the next request; offboarding is bounded by the 30s identity TTL, not by any team cache. Scope: document this, add the expansion query budget from TM3, and *only if* the assembled authz context is later cached does explicit team-keyed busting become in-scope. | Reframed |
| TM6 | **Legibility: effective-access + provenance.** "Who can do what here, and *via which team/grant*" view + `grantedVia` provenance on grants — union-over-teams is otherwise undebuggable. Promoted from a risk-mitigation note to a first-class milestone (parity with GitHub/Datadog team surfaces). | Draft |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| Account-owned Teams (`teams` + `team_members`); `subject_type='team'` grants via the existing `role_assignments`; authz-context fact expansion; team CRUD + membership + grant surfaces; account-RBAC permissions for managing teams; `team.*` audit/events; effective-access + provenance view (TM6); team-lifecycle grant cleanup | **Nested teams** (teams-in-teams) and **teams-as-hierarchy-level** (Account→Team→Workspace) — both deferred (Stage 2 / future); **resources owned by a team** (resources stay on workspace/project); the account-RBAC primitive itself (shipped in `saas-workspace-id` WID6); a bespoke authz-context cache (none exists today — expansion runs live per request); deny/negative permissions (the engine is allow-only) |

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
