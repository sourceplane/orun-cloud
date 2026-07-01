# saas-teams — Implementation Plan (TM1–TM6)

Each milestone is a candidate scope for one coherent PR-sized task. The epic is
**additive**: it adds two tables, one `subject_type` value, an authz-context expansion,
and management surfaces — **no policy-engine rewrite, no tenancy remodel.**

**Prerequisite — cleared.** `saas-workspace-id` **WID6** (`scope_kind='account'` + the
policy cascade) has **shipped** (migration `420_membership_account_rbac`; cascade in
`apps/membership-worker/src/handlers/authorization-context.ts`), so TM3's account-scope
team grants have a live resolver to ride. **Soft dependency for TM4:** WID6 shipped only
the account-role *grant* path and deferred account-role **list/revoke** to the
admin-portal follow-up — the team grant-management UI needs that same list/revoke
plumbing (see `risks-and-open-questions.md`, R-LR).

## TM1 — Data model

- `packages/db`: migration adding `membership.teams` (`account_org_id`, `name`,
  `slug_lower`, `status`, unique `(account_org_id, slug_lower)`) and
  `membership.team_members` (`team_id`, `subject_id`, `subject_type`, `status`, unique
  `(team_id, subject_id)`).
- **Widen the `role_assignments` CHECK:** `DROP … + ADD`
  `role_assignments_subject_type_check` to admit `'team'` (currently
  `user | service_principal`), following the guarded, additive-idempotent DO-block
  pattern `420_membership_account_rbac` used for `scope_kind`. Add the analogous
  `team_members.subject_type` check.
- `packages/db/src/ids`: `generateTeamId()`/`isTeamId()` → `team_<base32>` (shared codec).
- Owner: `packages/db`.
- **Done when:** teams + team_members exist with indexes; the `subject_type` CHECK admits
  `'team'`; repository CRUD + membership add/remove pass; ids mint as `team_…`.

## TM2 — Grants via `role_assignments`

- `apps/membership-worker`: allow `subject_type='team'` in `role_assignments`;
  grant/revoke a team a role at `account` | `organization` (workspace) | `project` scope.
  **Reuse the `grant-account-role.ts` shape** (validate the grantor's authority on the
  scope org, then write one `role_assignments` row) rather than authoring a parallel
  grant path — the only deltas are `subjectType: 'team'` and generalizing the scope.
- Authority to grant follows the grant's scope (account-admin for account scope, etc.).
- **Team-delete cleanup:** deleting a team **cascade-revokes** its
  `subject_type='team'` grants (don't orphan grant rows pointing at a dead `team_` id).
- Owner: `packages/db` + `apps/membership-worker`.
- **Done when:** a team can be granted/revoked a role at all three scopes; grants are
  validated against the grantor's scope authority; deleting a team revokes its grants;
  tests cover grant + revoke + scope enforcement + delete-cascade.

## TM3 — Authorization-context expansion

- `apps/membership-worker` (`authorization-context.ts`): after the direct + account
  cascade steps, load the actor's active `team_members`, then resolve their
  `subject_type='team'` grants on **both** the target org and the account org (for the
  account cascade) via **`listRoleAssignmentsForSubjects`** (one batched query — no
  N+1), and `mapRoleAssignmentsToFacts` them into the fact list. Account-scope team facts
  are stamped with the target orgId exactly like the existing account cascade.
- **Hot-path budget:** short-circuit both team queries when the account owns no teams (a
  cheap cached count/existence check), so team-less accounts pay ~zero on this
  PERF2-sensitive path.
- `packages/policy-engine`: **unchanged** — verify it unions team-derived facts exactly
  like direct facts (add tests; no code change expected).
- Owner: `apps/membership-worker` (+ `packages/policy-engine` tests).
- **Done when:** a user with no direct role but membership in a granted team is
  authorized for that team's permissions; account-scope team grants authorize across all
  workspaces; a removed team member loses access on the **next request** (no cache to
  wait on — see TM5); team-less accounts issue no extra team queries; union semantics
  verified.

## TM4 — Management surfaces

- Role/permission catalog: add `team.create|update|delete`,
  `team.member.add|remove`, `team.role.grant|revoke` at account scope.
- `apps/api-edge` + `packages/contracts`/`sdk`/`cli`: team CRUD, membership, and grant
  endpoints/commands. **Grant-management UI depends on account-role list/revoke** (R-LR)
  — either land that follow-up first or ship team list/revoke as its generalization.
- **Audit/events:** emit `team.*` events + audit rows on every mutation, following the
  existing membership-handler pattern (`create-organization`, `*-invitation`,
  `*-member`). Backfill the missing audit on `grant-account-role` in the same pass.
- `apps/web-console-next`: account-level Teams management (list/create, members, grants),
  reusing the existing member-management chrome.
- Owner: `apps/api-edge` + `packages/contracts`/`sdk`/`cli` + `apps/web-console-next`.
- **Done when:** an account admin can create a team, manage members, and grant it roles
  from console + SDK + CLI; permissions gate every mutation; every mutation emits an
  audit/event row; surfaces speak Account/Workspace vocabulary.

## TM5 — Cache & hot-path cost (PERF note, not a blocker)

- **Corrected premise:** the PERF2 actor cache holds only token→identity (30s TTL), not
  role facts or team membership (`apps/api-edge/src/actor-cache.ts`), so a removed team
  member loses derived access on the **next request** — there is no team cache to bust.
  Offboarding is already immediate; this milestone is not a correctness gate.
- Scope: (a) record the corrected revocation-window statement (T5); (b) own the
  expansion query budget introduced in TM3 (batch + no-teams short-circuit); (c) define
  the **trigger condition** — *if* a later PERF task memoizes the assembled authz
  context, explicit busting on `team_members`/team-grant change (keyed by actor+team)
  becomes required at that point, not now.
- Owner: `apps/membership-worker` (+ `apps/api-edge` only if/when context caching lands).
- **Done when:** the revocation window is documented; TM3's expansion carries the query
  budget; the "cache-the-context ⇒ must-bust" trigger is recorded.

## TM6 — Legibility: effective-access + provenance

- Union-over-teams makes "why can this actor do X here?" hard to answer. Ship the
  answer as a surface: an **effective-access view** ("who can do what here, and via which
  team/grant") and `grantedVia` provenance (direct | team `team_…` | account cascade) on
  listed grants.
- Owner: `apps/api-edge` + `packages/contracts`/`sdk`/`cli` + `apps/web-console-next`.
- **Done when:** an admin can see an actor's effective permissions on a
  workspace/project with each traced to its source grant; account-scope team grants are
  labeled "via Team X at Account scope". Parity target: GitHub/Datadog team-access views.

## Sequencing note

WID6 is landed, so nothing external gates the epic. TM1→TM2→TM3 is the critical path
(model → grants → authz). TM4 (surfaces) follows TM3 so management acts on working
authorization, and its grant-management UI sequences behind the account-role list/revoke
follow-up (R-LR). TM5 is a documentation/PERF milestone that rides along with TM3, **not**
a pre-adoption blocker. TM6 (legibility) should land before Teams are used at scale —
un-provenanced union access becomes an audit liability fast. Nesting and
teams-as-hierarchy-level are explicitly **not** milestones here (deferred to
`saas-workspace-id` Stage 2 / future).
