# teams-foundation (TF) — Design

Status: Draft (normative once TF1 lands). Written against repo reality as of 2026-07-01
and **additive over `saas-teams` (TM)**, which already defines `membership.teams`,
`membership.team_members`, and `subject_type='team'` grants via `role_assignments`.

## 1. What TF adds over TM

TM's `teams` table is `(id, account_org_id, name, slug_lower, status, …)` and
`team_members` is `(team_id, subject_id, subject_type, status)`. That is enough to *grant
a team a role*. TF makes the team a thing the product can *point at*:

- a **handle** — a short, mentionable, account-unique key (`@payments`) that git
  ownership (**TO**) and mentions (**TC**) resolve against;
- a **profile** — `description`, `avatar_ref` — so a team has a page (**TH**);
- a **membership role** — `team_admin` vs `team_member` — so a team is self-managed
  rather than requiring an account admin for every roster change.

## 2. Schema deltas (TF1 + TF2)

```sql
-- TF1: enrich the TM teams row (additive columns).
ALTER TABLE membership.teams
  ADD COLUMN IF NOT EXISTS handle       TEXT,          -- account-unique, e.g. 'payments'
  ADD COLUMN IF NOT EXISTS description  TEXT,
  ADD COLUMN IF NOT EXISTS avatar_ref   TEXT;          -- opaque ref / initials fallback

-- Account-unique handle (teams span workspaces, so uniqueness is per ACCOUNT).
CREATE UNIQUE INDEX IF NOT EXISTS teams_account_handle_idx
  ON membership.teams (account_org_id, lower(handle))
  WHERE handle IS NOT NULL AND status <> 'deleted';

-- TF2: team-management role on the membership row.
ALTER TABLE membership.team_members
  ADD COLUMN IF NOT EXISTS team_role TEXT NOT NULL DEFAULT 'team_member';
-- CHECK widened via the guarded DROP+ADD DO-block pattern (see 420_membership_account_rbac):
--   team_role IN ('team_admin','team_member')
```

`team_` public id (minted in TM) is the **immutable** external reference. The `handle`
is account-unique and *may* be renamed; grants and every cross-surface reference bind to
the `team_` id (§4), so a rename never rewrites a grant, an owner mapping, or a routing
rule. The `id` is the truth; the `handle` is the ergonomics.

## 3. Two authority planes — the load-bearing distinction

There are **two** different "who can…" questions about a team, and conflating them is the
classic teams-RBAC bug:

| Plane | Question | Governed by |
|-------|----------|-------------|
| **Team management** | Who can rename the team, change its avatar, add/remove **members**? | `team_admin` on that team (TF2) — *or* an account admin (WID6) as a superset |
| **Platform grants** | Who can decide **what the team can do** (grant it `builder` on `ws_X`)? | The **grantor's scope authority** — account-admin for account-scope, workspace-admin for workspace-scope, project-admin for project-scope (unchanged from `saas-teams` TM2) |

The separation matters: a **team admin curates the roster but cannot escalate the team's
power** — adding yourself to a powerful team is only useful if someone with *scope
authority* granted that team its power. This mirrors GitHub (team maintainer manages
members; org owner decides repo access) and prevents privilege escalation via roster
edits. Membership changes are still **audited** (TF5) and take effect on the next
authorization (no cache to bust — see `saas-teams` design §7).

## 4. Access-principal integration (TF3) — the entity IS the subject

`saas-teams` writes `role_assignments { subject_id: 'team_…', subject_type: 'team' }`. TF3
is a *verification + invariant* milestone, not new machinery:

- The **only** legal value of a `subject_type='team'` `subject_id` is a live `team_`
  entity id (a deleted/renamed team must not leave a dangling grant — TM2's
  delete-cascade-revoke covers delete; TF adds the FK-in-spirit check at grant time).
- Because grants bind to the id and never the handle, TF1's rename is free.

No change to `packages/policy-engine` — it consumes expanded facts and never sees
`subject_type` (confirmed in `saas-teams` design §3).

## 5. Effective-access + provenance (TF4)

Promotes `saas-teams` TM6 into the foundation, because every later plane needs it.

- **Effective-access view**: for `(actor, workspace|project)`, list the actions the actor
  can perform and, for each, *why* — the winning fact and its origin.
- **`grantedVia` provenance** on every listed grant: `direct` | `team:team_…` |
  `account-cascade`. Assembled in `apps/membership-worker` alongside the authz-context
  expansion (the origin is known at expansion time; carry it through instead of
  discarding it).

Provenance is not a nicety: union-over-teams + account cascade means "who can touch this"
is opaque without it, and it is the data the **TH** team page and **TG** access reviews
render.

## 6. Audit & events (TF5)

Every mutation emits a `team.*` event + audit row through the existing
membership-handler pattern (`create-organization`, `*-invitation`, `*-member` all do
this today; `grant-account-role` is the one gap — backfill it here):
`team.created` · `team.updated` · `team.deleted` · `team.member.added` ·
`team.member.removed` · `team.member.role_changed` · `team.role.granted` ·
`team.role.revoked`. Authority changes must be attributable for the **TG** compliance
story.

## 7. Alternatives considered

- **Leave Team as the bare TM principal** — rejected: ownership/hub/collaboration have
  nothing to bind to; "Datadog Teams" is impossible without an entity + handle.
- **One role plane (account admin manages everything)** — rejected: does not scale (every
  roster edit escalates to an account admin) and blocks Datadog-style self-service teams.
- **Handle as the primary key / grant subject** — rejected: renames would rewrite grants,
  owner maps, and routing rules. The immutable `team_` id is the anchor; the handle is a
  mutable alias.
- **Global (account-crossing) handles** — rejected: teams are account-owned; a handle is
  unique per account, matching the tenancy boundary and avoiding cross-tenant leakage.
