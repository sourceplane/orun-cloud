# saas-teams — Design

Status: Draft (normative once TM1 lands)

Teams as **account-owned principals** at Stage 1. Written against repo reality as of
2026-06-30: `membership.role_assignments` already carries `subject_id TEXT` +
`subject_type` + `scope_kind`('organization'|'project')/`scope_ref`
(`packages/db/src/migrations/020_membership_core/up.sql`); the policy engine evaluates
a list of role facts and **unions** their permissions, denying when no fact matches the
scope (`packages/policy-engine/src/index.ts`: `relevantFacts =
context.memberships.filter(f => f.scope.orgId === orgId)`); authorization context is
assembled in `apps/membership-worker` and passed to the policy worker; the actor/authz
resolution is cached (PERF2, `apps/api-edge/src/resolve-actor.ts` + `actor-cache.ts`).

**Hard prerequisite:** `saas-workspace-id` **WID6** adds `scope_kind='account'` + the
policy cascade. Teams are granted *within* that authority model.

## 1. The shape — a Team is a principal, not a level

A Team is a named group of subjects that a role can be granted to, exactly like a user.
It owns no resources and is not a tenancy level. This is what makes it additive: it
plugs into the grant machinery already in place, and the only new behavior is expanding
"the actor's teams" into the actor's effective facts.

## 2. Data model (TM1) — two tables, one enum extension

Teams are owned by the **Account** (the parent org / `effectiveBillingOrgId`), so they
can be granted across every Workspace in the account.

```sql
-- membership.teams  → public id team_<base32> (matches the ws_ direction)
CREATE TABLE membership.teams (
  id              UUID PRIMARY KEY,
  account_org_id  UUID NOT NULL,        -- owning account (parent org)
  name            TEXT NOT NULL,
  slug_lower      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_org_id, slug_lower)
);

-- membership.team_members  → who is in the team
CREATE TABLE membership.team_members (
  team_id       UUID NOT NULL,
  subject_id    TEXT NOT NULL,          -- usr_… / sp_…
  subject_type  TEXT NOT NULL DEFAULT 'user',  -- user | service_principal
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, subject_id)
);
```

No new grants table: a Team becomes an assignable principal by allowing
**`subject_type = 'team'`** in `role_assignments`, with `subject_id` = the team's public
id. A grant at any scope is just a row:

```
-- "grant team Platform the builder role on workspace ws_X"
role_assignments { org_id: <X uuid>, subject_id: 'team_3KF9TQ2P', subject_type: 'team',
                   role: 'builder', scope_kind: 'organization' }
-- account-scope grant (cascades to all workspaces — see §4)
role_assignments { org_id: <account uuid>, subject_id: 'team_…', subject_type: 'team',
                   role: 'admin', scope_kind: 'account' }   -- needs WID6
```

## 3. Authorization — expand at context assembly; engine unchanged (TM3)

The only behavioral change lives in `apps/membership-worker`'s authorization-context
builder. Today it returns the actor's direct role facts; add two steps:

```
buildAuthorizationContext(actor, orgId):
  facts  = direct role_assignments for actor                     # today
  teams  = team_members where subject_id = actor (status=active) # NEW
  facts += role_assignments where subject_type='team'            # NEW
            AND subject_id IN teams
  facts += account-scoped facts (WID6 cascade)                   # from WID6
  return facts
```

The **policy engine does not change**. It already takes a fact list, filters by scope,
unions permissions, and allows when the action is present. It cannot tell — and must not
care — whether a fact arrived directly, via a team, or via the account cascade.

```
effective(actor, action, scope)
  = ⋃ permissions over { direct facts } ∪ { facts via each team }
                       ∪ { account-cascade facts }      # allow-only → union is safe
```

This is the clean separation: **teams resolve at assembly time; the engine stays a pure
function.** Blast radius = the context builder, not the evaluator.

## 4. The inheritance payoff (why account-owned + resolve-up)

Because Teams are account-owned and authorization resolves **up** at read time:

- An **account-scope** team grant cascades (via WID6) to **every** Workspace in the
  account.
- Creating a **new Workspace** under the account → the team already has access, with
  **zero backfill**: the account-scope grant is resolved when the new workspace is
  authorized; nothing was copied, so nothing must be migrated.
- A **workspace-scope** team grant still works for "this team, only on `ws_X`" — so
  workspace-local teams are a strict subset; no separate concept is needed.

That auto-coverage of future workspaces is the "account-managed, inherited" behavior the
account layer promised.

## 5. Managing teams — reuse account RBAC (TM4)

Team lifecycle is governed by the Stage-1 account roles (`account_owner`/`account_admin`
from WID6). Extend the role/permission catalog with: `team.create`, `team.update`,
`team.delete`, `team.member.add`, `team.member.remove`, `team.role.grant`,
`team.role.revoke`. Authority to grant a team a role **follows the grant's scope**:
account-scope grants by account admins; workspace-scope grants by that workspace's
admins; project-scope by project admins. Surfaces (console/SDK/CLI) mirror the existing
member-management chrome.

## 6. Identity

Team public id = **`team_<base32>`** (Crockford base32, matching the `ws_` direction in
`saas-workspace-id`). Teams are referenced in grant APIs, so a readable, copy-safe id
helps; they are less "quoted to support" than Accounts, so no special ergonomics beyond
the shared convention.

## 7. Cache invalidation (TM5)

The PERF2 actor/authz cache makes a removed team member (or a revoked team grant) keep
working until the entry expires — a correctness risk for offboarding. Options:

- **Explicit bust** on `team_members` / team-`role_assignments` change (precise; needs a
  cache-key strategy keyed by actor/team), or
- **Short TTL** for any authz context that drew on a team fact (simple; bounded
  staleness).

Decide in `risks-and-open-questions.md` (T5). Default lean: short TTL now, explicit bust
if the staleness window proves too wide for offboarding SLAs.

## 8. Stage-1 scope lines (what we deliberately defer)

- **Teams are principals, not containers** — no resources ever hang off a team;
  resources stay on workspace/project. Keeps teams orthogonal to tenancy.
- **Flat teams** — no nesting (teams-in-teams) yet; nesting needs recursive expansion
  (same complexity as nested orgs) and is a later enhancement.
- **No teams-as-hierarchy-level** — Account→Team→Workspace deepens the 2-level
  `parent_org_id` tree and belongs to `saas-workspace-id` Stage 2, not here.
- **Allow-only** — no deny/negative grants; union semantics stay valid. (Deny rules
  would force conflict resolution and are out of scope.)

## 9. Alternatives considered (and why rejected)

- **Teams as a hierarchy level** — deepens the tree, conflates grouping-users with
  grouping-resources; defer to WID Stage 2.
- **A dedicated `team_role_assignments` table** — unnecessary; `subject_type='team'`
  reuses the engine and keeps evaluation agnostic. Less code, fewer joins to reconcile.
- **Workspace-local-only teams** — weaker; does not deliver the account-managed/inherited
  story. Account-owned teams subsume it (grant on a single workspace when wanted).
