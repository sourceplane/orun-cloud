# teams-foundation (TF) — Implementation Status (as-built)

Status: **✅ Shipped (TF1–TF5).** As-built record, kept distinct from the
design/plan. Additive over `saas-teams` (TM); no grant re-model.

## TF1 — Team entity (handle + profile) ✅

- `packages/db` migration `530_membership_teams_foundation` — adds
  `membership.teams.handle` / `description` / `avatar_ref`; partial unique index
  `teams_account_handle_idx (account_org_id, lower(handle)) WHERE handle IS NOT NULL
  AND status <> 'deleted'` (account-unique, case-insensitive, live-only; a deleted
  team frees its handle). `Team` type + `mapTeam` + `createTeam`/`updateTeam` carry
  the columns.
- `apps/membership-worker/handlers/teams.ts` — create/update accept + validate an
  optional handle (`^[a-z0-9][a-z0-9-]{1,38}$`, lower-cased), description (≤500),
  avatar; handle uniqueness enforced by the DB index (409).
- `packages/contracts` `PublicTeam` / `CreateTeamRequest` / `UpdateTeamRequest`
  gain `handle`/`description`/`avatar`; SDK passes through; CLI flags + columns;
  console create form + list column + team-page header.
- **Decisions:** TF-A account-unique lower-kebab handle; TF-D opaque `avatar_ref`
  (initials+colour rendered client-side).

## TF2 — Team-management roles ✅

- Migration `540_membership_team_roles` — `membership.team_members.team_role`
  (DEFAULT `team_member`, CHECK `team_admin|team_member` via a guarded DO-block;
  TM-era rows backfill). `addTeamMember` carries `team_role`; new `getTeamMember`
  and `updateTeamMemberRole`.
- Two authority planes in `teams.ts`: team management (rename/profile, roster
  add/remove, member-role change) is allowed for an account admin **or** an active
  `team_admin`; platform-grant authority (what the team can *do*) unchanged.
  `handleUpdateTeamMemberRole` (PATCH member) emits `team.member.role_changed`.
- api-edge + router: PATCH on the team member-id route. Contracts/SDK/CLI/console
  surface `teamRole` (add `--role`, `team member-role`, promote/demote UI).
- **Decision:** TF-B — team creation stays account-admin only; `team_admin` covers
  per-roster self-service.

## TF3 — Access-principal integration ✅

- `grant-team-role.ts` asserts the target team is **active** explicitly (alongside
  the existing same-account check) so a `subject_type='team'` grant can only bind
  to a live `team_` entity in the account; grants continue to write
  `subject_id = team_<hex>` (id-bound — a handle rename never rewrites a grant).
- Proven by tests: grant rejects a soft-deleted team (404) and binds to the id not
  the handle; `packages/policy-engine` (unchanged) gains a block showing
  team-derived facts are id-bound (rename-safe) and delete-safe (a deleted team
  produces no fact).

## TF4 — Effective-access + provenance ✅

- Backend (`FactOrigin`, mapper stamping, engine `via` reporting, internal + public
  effective-access endpoints, api-edge/SDK/CLI surfaces) delivered by `saas-teams`
  TM6; **verified** here (direct | team | account_cascade end-to-end).
- `apps/web-console-next` effective-access view resolves a `team_` id to the team's
  display name — "via Team Payments (@payments)" — instead of the raw id.
- `packages/policy-engine` unchanged.

## TF5 — Audit & events ✅

- `grant-team-role` emits `team.role.granted`, `revoke-team-role` emits
  `team.role.revoked` — each written atomically with the grant/revoke via
  `executor.transaction` + `appendEventWithAudit`. Completes the `team.*` family
  (created/updated/deleted, member added/removed/role_changed, role
  granted/revoked). `grant-account-role` already carried its `account.role.granted`
  audit (TM4b2).

## Not in scope (per the epic boundary)

Owner-handle → team **resolution** (→ TO), notification routing (→ TC), team pages
/ cross-workspace aggregation (→ TH), SCIM sync + restriction/custom-roles (→ TG),
nested teams / teams-as-level (WID Stage 2). Open item **TF-C** (self-service join
for "open" teams) intentionally deferred — closed-only at v1.
