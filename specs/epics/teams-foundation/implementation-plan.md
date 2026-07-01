# teams-foundation (TF) — Implementation Plan (TF1–TF5)

Additive over `saas-teams` (**TM**). Each milestone is a PR-sized slice. **Prerequisite:**
TM1–TM3 (tables + `subject_type='team'` grants + authz expansion). TF does **not** re-model
grants; it enriches the entity and its management.

## TF1 — Team entity (handle + profile)

- `packages/db`: additive columns on `membership.teams` (`handle`, `description`,
  `avatar_ref`); account-unique partial index on `lower(handle)`.
- `apps/membership-worker`: team profile CRUD (create/read/update/delete) with the handle
  uniqueness check scoped to the account; delete stays soft (`status='deleted'`) and rides
  TM2's grant delete-cascade.
- `packages/contracts`/`sdk`/`cli`: `Team` shape gains `handle`/`description`/`avatar`.
- **Done when:** a team can be created with a handle + profile; handles are account-unique
  and case-insensitive; the `team_` id is immutable across a handle rename; CRUD is
  covered by tests.

## TF2 — Team-management roles

- `packages/db`: `team_members.team_role` (`team_admin`/`team_member`, CHECK widened via
  the guarded DO-block pattern).
- `apps/membership-worker`: authorize roster mutations against `team_admin` on the team
  **or** an account admin (WID6); keep this authority **separate** from platform-grant
  authority (grants remain gated by the grantor's scope, per TM2).
- **Done when:** a `team_admin` can add/remove members and edit the profile without an
  account-admin role; a `team_admin` **cannot** change what the team is *granted*; every
  path is permission-gated and tested.

## TF3 — Access-principal integration

- `apps/membership-worker`: at team-grant time, validate `subject_id` is a live `team_`
  entity in the same account; ensure grants/owner-maps/routing never key on the handle.
- `packages/policy-engine`: **unchanged** — add a test that a renamed team keeps its grants
  (id-bound), and a deleted team confers nothing.
- **Done when:** team grants are provably id-bound (rename-safe, delete-safe); no dangling
  `subject_type='team'` rows can be created against a missing/other-account team.

## TF4 — Effective-access + provenance

- `apps/membership-worker`: carry the fact **origin** through authz-context assembly
  (`direct` | `team:team_…` | `account-cascade`) instead of discarding it.
- `apps/api-edge` + `packages/contracts`/`sdk`/`cli`: an effective-access endpoint
  (`actor × workspace|project → permitted actions + winning source`) and `grantedVia` on
  listed grants.
- `apps/web-console-next`: render "can do X here — via Team Y at Account scope".
- **Done when:** an admin can see an actor's effective permissions on a workspace/project,
  each traced to its source grant; account-scope team grants read as "via Team X at
  Account scope". Parity target: GitHub/Datadog access views.

## TF5 — Audit & events

- `apps/membership-worker`: emit `team.*` events + audit rows on every mutation via the
  existing `appendEventWithAudit` pattern; backfill the missing audit on
  `grant-account-role` in the same pass.
- **Done when:** every team mutation writes an attributable audit row; the account-role
  grant audit gap is closed; events are covered by tests.

## Sequencing note

TF1 → TF2 → TF3 is the entity critical path; TF4 (provenance) and TF5 (audit) can land in
parallel with TF2/TF3. TF is the hard prerequisite for **TO** (the resolver needs the
handle) and is consumed by **TH**/**TC**/**TG**.
