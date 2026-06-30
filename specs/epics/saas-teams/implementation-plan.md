# saas-teams — Implementation Plan (TM1–TM5)

Each milestone is a candidate scope for one coherent PR-sized task. The epic is
**additive**: it adds two tables, one `subject_type` value, an authz-context expansion,
and management surfaces — **no policy-engine rewrite, no tenancy remodel.**

**Prerequisite:** `saas-workspace-id` **WID6** (`scope_kind='account'` + the policy
cascade) must land first; TM3's account-scope team grants resolve through it.

## TM1 — Data model

- `packages/db`: migration adding `membership.teams` (`account_org_id`, `name`,
  `slug_lower`, `status`, unique `(account_org_id, slug_lower)`) and
  `membership.team_members` (`team_id`, `subject_id`, `subject_type`, `status`, unique
  `(team_id, subject_id)`).
- `packages/db/src/ids`: `generateTeamId()`/`isTeamId()` → `team_<base32>` (shared codec).
- Owner: `packages/db`.
- **Done when:** teams + team_members exist with indexes; repository CRUD + membership
  add/remove pass; ids mint as `team_…`.

## TM2 — Grants via `role_assignments`

- `packages/db` + `apps/membership-worker`: allow `subject_type='team'` in
  `role_assignments`; grant/revoke a team a role at `account` | `organization`
  (workspace) | `project` scope.
- Authority to grant follows the grant's scope (account-admin for account scope, etc.).
- Owner: `packages/db` + `apps/membership-worker`.
- **Done when:** a team can be granted/revoked a role at all three scopes; grants are
  validated against the grantor's scope authority; tests cover grant + revoke + scope
  enforcement.

## TM3 — Authorization-context expansion

- `apps/membership-worker` (context assembly): expand the actor's active
  `team_members` into the `subject_type='team'` `role_assignments` they reach, merge
  into the fact list passed to the policy worker; include the WID6 account cascade.
- `packages/policy-engine`: **unchanged** — verify it unions team-derived facts exactly
  like direct facts (add tests; no code change expected).
- Owner: `apps/membership-worker` (+ `packages/policy-engine` tests).
- **Done when:** a user with no direct role but membership in a granted team is
  authorized for that team's permissions; account-scope team grants authorize across all
  workspaces; a removed team member loses access (modulo TM5 cache); union semantics
  verified.

## TM4 — Management surfaces

- Role/permission catalog: add `team.create|update|delete`,
  `team.member.add|remove`, `team.role.grant|revoke` at account scope.
- `apps/api-edge` + `packages/contracts`/`sdk`/`cli`: team CRUD, membership, and grant
  endpoints/commands.
- `apps/web-console-next`: account-level Teams management (list/create, members, grants),
  reusing the existing member-management chrome.
- Owner: `apps/api-edge` + `packages/contracts`/`sdk`/`cli` + `apps/web-console-next`.
- **Done when:** an account admin can create a team, manage members, and grant it roles
  from console + SDK + CLI; permissions gate every mutation; surfaces speak
  Account/Workspace vocabulary.

## TM5 — Cache invalidation

- Invalidate (explicit bust) or bound (short TTL) the PERF2 actor/authz cache when
  `team_members` or a team `role_assignment` changes, so offboarding/role changes take
  effect predictably.
- Owner: `apps/api-edge` (`resolve-actor`/`actor-cache`) + `apps/membership-worker`.
- **Done when:** removing a member from a team (or revoking a team grant) revokes the
  derived access within the agreed window; the strategy + window are recorded (T5).

## Sequencing note

WID6 gates the epic. TM1→TM2→TM3 is the critical path (model → grants → authz). TM4
(surfaces) follows TM3 so management acts on working authorization. TM5 (cache) should
land with or immediately after TM3 — before teams are used for anything offboarding-
sensitive. Nesting and teams-as-hierarchy-level are explicitly **not** milestones here
(deferred to `saas-workspace-id` Stage 2 / future).
