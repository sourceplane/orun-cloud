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
                   role: 'admin', scope_kind: 'account' }   -- WID6 (shipped)
```

**The migration must widen two CHECK constraints — the SQL sketch above hides real
work.** `role_assignments` today enforces
`role_assignments_subject_type_check CHECK (subject_type IN ('user','service_principal'))`
(`020_membership_core/up.sql`); TM1/TM2 must `DROP … + ADD` it to include `'team'`,
following the guarded-DO-block, additive-idempotent pattern that `420_membership_account_rbac`
used to widen `scope_kind`. The same applies to the new `team_members.subject_type` check
(`user | service_principal`). The `role` check is untouched — team grants reuse the
existing roles. Note also that the existing partial-unique index
`role_assignments_active_idx (org_id, subject_id, role, scope_kind, COALESCE(scope_ref,''))`
already accommodates team rows for free, because `subject_id` (the `team_` id) differs
from any user's.

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

**Reuse, don't reinvent, the grant path.** `apps/membership-worker/src/handlers/grant-account-role.ts`
already implements "validate the grantor's authority on the right scope org, then write a
`role_assignments` row" for account roles. A team grant is the same handler with
`subjectType: 'team'` and the scope generalized to account | organization | project —
copy its authorization shape rather than authoring a parallel one. **Gap to close:** that
handler writes **no audit/event row** (unlike every other membership mutation —
`create-organization`, `*-invitation`, `*-member`). TM4 must emit `team.*` events/audit
on create/update/delete/member-add/remove/grant/revoke, and should backfill the
account-role grant while it is there — a SaaS admin/compliance surface is not credible
without an audit trail of authority changes.

**Lifecycle cleanup (specify it — the original draft was silent).**

- **Team delete** → cascade-revoke every `role_assignments` row with
  `subject_type='team', subject_id=<team>`. Expansion filters on an existing/active team
  so a deleted team stops conferring access regardless, but leaving orphan grant rows
  pointing at a dead `team_` id corrupts the TM6 effective-access view and audit history.
  Revoke, don't orphan.
- **Member leaves the account** (org membership removed) → also remove them from the
  account's teams, or their team-derived access silently outlives their account
  membership. Wire this into the existing `remove-member` handler.
- **Grants bind to the immutable id, never the slug** — `subject_id` stores the
  `team_<base32>` public id, which is immutable; renaming a team (slug/name change) must
  not touch any grant. State this invariant so no one "helpfully" keys grants on slug.

## 6. Identity

Team public id = **`team_<base32>`** (Crockford base32, matching the `ws_` direction in
`saas-workspace-id`). Teams are referenced in grant APIs, so a readable, copy-safe id
helps; they are less "quoted to support" than Accounts, so no special ergonomics beyond
the shared convention.

## 7. Cache & hot-path cost (TM5) — corrected against repo reality

**The original premise was wrong.** The "PERF2 actor/authz cache"
(`apps/api-edge/src/actor-cache.ts`) caches **only the token→`ActorInfo`
resolution** — `subjectId`, `subjectType`, `email`, `orgId` — for a 30s TTL. It does
**not** cache role facts, team membership, or authorization decisions. The
authorization context (direct facts + account cascade + — with this epic — team facts)
is **re-assembled live on every authorize** in
`apps/membership-worker/src/handlers/authorization-context.ts`. Consequences:

- **Offboarding is already immediate.** Remove a member from a team (or revoke a team
  grant) and the *next* request re-assembles without that fact. There is no
  team-derived cache entry to bust; the only residual staleness is the 30s identity
  cache, which carries no team data. So the "removed member keeps access until expiry"
  risk **does not exist** as described — TM5 is not a correctness blocker.
- **The real cost is the inverse: added queries on the hot path.** Expansion adds a
  `team_members`-by-actor lookup plus a team-grants lookup (target scope **and** account
  scope) to a path PERF2 spent effort making fast. Mitigations, in order:
  1. **Reuse `listRoleAssignmentsForSubjects`** (already in the repo) so all of an
     actor's team grants resolve in one batched query, not N+1.
  2. **Short-circuit when the account has no teams** — a cheap cached count/existence
     check skips both team queries entirely for the (initially majority) team-less
     accounts, so non-adopters pay ~zero.
  3. Fold the actor's team-ids into the same round trip that already fetches the account
     cascade where practical.
- **Invalidation only re-enters scope if you later cache the assembled context.** If a
  future PERF task memoizes the *authz context* (not just identity), it **reintroduces**
  the staleness this section imagined — at which point explicit busting on
  `team_members` / team-grant change, keyed by actor and team, becomes required. Record
  that as the trigger condition, not as work for Stage 1.

Decision + revocation-window statement live in `risks-and-open-questions.md` (T5).

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
