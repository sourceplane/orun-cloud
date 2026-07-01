# teams-hub (TH) — Design

Status: Draft. Written against repo reality as of 2026-07-01: the Account is a
`parent_org_id` reference resolved by `effectiveBillingOrgId` (`specs/core/vocabulary.md`)
with **no dedicated console surface** (no account page, no account-members page); WID6
ships account-role **grant** (`grant-account-role.ts`) but **defers list/revoke**;
`list-account-workspaces` (IT12) enumerates child workspaces for a picker; catalog
(`state.org_catalog_entities`) and runs (`state.runs`, migrations `360_state_runs_org_index`
etc.) are **per-org indexed**.

## 1. Thicken the surface, not the tree

The temptation, when Teams need an account home, is to make Account a real hierarchy node
(`Account → Team → Workspace`). We **reject** that (it is WID Stage 2 and deepens tenancy).
Instead we add a **surface** — an Account Hub — over the existing thin `parent_org_id`
reference. Nothing in the tenancy model changes; we are building UI + read-aggregation over
data that already exists (the account org, its child workspaces, account-scoped
`role_assignments`, teams).

### Account Hub information architecture (TH1)

A new account-scoped console area (sibling to the per-workspace shell), reached from the
Account chip / switcher (WID5 already badges Account vs Workspace):

- **Overview** — account name, workspace count, member count, ownership coverage (TO5),
  usage rollup.
- **Workspaces** — the child list (`list-account-workspaces`/IT12), create/link.
- **Members** — account-level member roster (see §2 on what "account member" means).
- **Roles** — account-role grant **+ list + revoke** (finishing WID6's deferred half).
- **Teams** — the team roster (TF), create/manage, per-team owned-entity counts (TO5).
- **Usage** — cross-workspace usage/quota rollup (rides the metering context).

This is the first real account surface; Teams is its anchor tenant, but it also lands the
account-member and account-role management WID left as API-only.

## 2. "Account member" — a derived view, not a new table

There is no `account_members` table and TH does **not** add one (membership stays per-org).
"Account members" on the hub is a **derived roster**: the union of

- subjects holding an **account-scoped** `role_assignment` on the account org (WID6), and
- subjects who are members of the account **root** org itself, and
- (optionally) a rollup of subjects across child workspaces, clearly labeled by workspace.

This keeps the tenancy model untouched while giving the hub an honest "who's in this
account" answer — and it finally surfaces the account-cascade admins who, today, can act
on workspaces where they appear in **no** workspace member list (the legibility gap TF4's
provenance also addresses).

## 3. Cross-workspace read layer (TH2) — fan-out, not a new store

A team's services live in whatever Workspaces host them, so the Team Page must read
**across** the account's Workspace set. Catalog + runs are per-org indexed, so:

```
accountCatalog(account, filter):
  workspaces = listChildWorkspaces(account) ∪ {account root}
  results    = ⋃ over workspaces w of  queryOrgCatalog(w, filter)   # per-org index, batched/bounded
  return results tagged with their workspace
```

- **Bounded fan-out**: cap concurrency and the workspace count per page; paginate by
  workspace when an account is large (TH-B budget). This is the same shape as the WID6
  account cascade (query parent + children), so it is a known pattern, not a new one.
- **No new denormalized cross-workspace table** — that would be a second source of truth to
  keep consistent with per-org projections. Fan-out keeps the per-org index authoritative.
- Team-page reads filter the fan-out by the team's **owned** entities (TO resolution), so
  the working set is "this team's services," not "every service in the account."

## 4. The Team Page (TH3, TH4)

Composed entirely from data the earlier epics produce:

- **Identity** (TF): name, `@handle`, description, avatar.
- **Members** (TF): roster with `team_admin`/`team_member`, add/remove.
- **Owned services** (TO): the team's entities across workspaces (via §3 fan-out +
  resolution), each with its catalog health/scorecard.
- **Coverage** (TO5): owned-entity count, unowned/unmapped backlog for this team.
- **Activity/deploys** (TH4): recent runs/deploys for the owned services — joins owned
  entities → runs via the run `component` ref (`packages/contracts/src/state.ts`); rides
  the SC2 (deployments) / SC3 (activity) tabs as they land.
- **Access** (TF4): what this team is granted, and where — with provenance.
- **On-call** (TC): team-level escalation/contact once **TC** lands (rendered read-only
  here; authored in TC).

## 5. Multi-workspace grant management (TH5) — the "add to many workspaces" action

This is the product answer to "can I add people to multiple workspaces from the account?"
Compose the IT12 picker with team grants:

- Pick a team, pick a **set** of workspaces (multi-select over `list-account-workspaces`),
  pick a role → write N workspace-scope `subject_type='team'` grants (or **one**
  account-scope grant when "all workspaces, including future" is intended — the WID6
  cascade).
- The account-scope option is the "everything" hammer (all current + future workspaces);
  the multi-select is the "these three" scalpel the platform lacks today.
- Adding a person to the team then reaches exactly those workspaces — "add once, reach the
  chosen many."

## 6. Alternatives considered

- **Make `accounts` a first-class entity now** — rejected: that is WID Stage 2 and a
  tenancy change; TH needs only a *surface*, which the reference model already supports.
- **A cross-workspace materialized catalog** — rejected: a second source of truth vs the
  per-org projections; fan-out over the existing indexes is consistent and cheaper to keep
  correct. Revisit only if fan-out latency proves unacceptable at large account sizes.
- **A dedicated `account_members` table** — rejected: membership stays per-org; the hub
  derives the roster (§2). Avoids a parallel membership model.
