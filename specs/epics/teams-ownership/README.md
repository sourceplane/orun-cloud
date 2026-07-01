# Epic: teams-ownership (TO)

**Make a Team the *ownership grain* of the product — "what's ours?" — by resolving the
git-authored `owner` string onto a real Team entity, then lighting up a "My Teams / My
Services" lens across the catalog and the activity feed.** This is the **keystone** of the
[`teams-platform`](../teams-platform/) program: it is the single move that turns a flat
metadata string into the connective tissue Datadog Teams is built on, **without violating
the catalog's git-authored invariant.** **Plane: Ownership.**

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — depends on `teams-foundation` **TF1** (the `team_` entity + handle) and the `saas-service-catalog`/`saas-catalog-portal` **owner** projection (already shipped: `state.org_catalog_entities.owner`, the console `group-by: team` dimension). |
| Cluster | **TO** (teams-ownership — the resolver + the lens) |
| Owner(s) | `apps/membership-worker` (owner-map registry) · `apps/state-worker` + `apps/api-edge` (resolution at read) · `packages/contracts`/`sdk` · `apps/web-console-next` (My Teams / My Services) |
| Builds on | `teams-foundation` **TF1** (handle); `saas-service-catalog` **SC6** (owner enrichment intent) + **SC8** ("My services" intent); `saas-catalog-portal` (`group-by: team`, owner-avatar rendering, "Unowned" state); the `18-state` *derived-never-authored* invariant |
| Decisions locked | (1) Ownership binds via an **account-authored resolver map** (owner-handle → `team_` id), **never** by writing catalog content — the git snapshot stays the source of truth for the `owner` string; (2) an unresolved/absent owner renders the portal's existing **"Unowned"** state; (3) resolution is **read-time** (no denormalized `team_id` on the catalog projection that would drift on re-projection); (4) "My Services" = catalog entities whose resolved owner is a team the viewer belongs to. |
| Gate | Confirm TO-A (map authority + collision policy), TO-B (owner-string grammar — bare handle vs `group:handle`), TO-C (resolution cache/TTL). See `risks-and-open-questions.md`. |

## Thesis

The catalog already carries `owner` (a git-authored free string), a console
**`group-by: team`** dimension that groups by that string, an owner-avatar renderer, an
"Unowned" state, and a **planned "My Services"** filter (SC8). What's missing is the one
link that makes all of it *real*: resolving `owner: payments` to the **Team entity**
`team_…` so ownership becomes navigable, filterable-by-membership, and scoreable.

The trap is doing this by writing a `team_id` onto the catalog — which the `18-state`
invariant forbids (*"the read-model is derived, never authored… the platform never edits
catalog content"*). The escape is Backstage's model: the console owns a **mapping** from
the git handle to the entity id. That map is *org metadata, not catalog content*, so the
invariant holds and the catalog projection is never touched. Land the resolver and ~70%
of "Datadog Teams" (My Services, team pages, ownership scorecards, team-routed
notifications) becomes reachable.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| TO1 | **Owner-map registry**: account-authored `owner_handle → team_id` map (table + CRUD + audit); collision + unmapped policy | Draft |
| TO2 | **Read-time resolution**: catalog reads resolve `owner` → `{team_, handle, name, avatar}` or "Unowned"; `group-by: team` groups on resolved identity | Draft |
| TO3 | **"My Teams / My Services" lens**: filter catalog + the flat Activities feed to the viewer's teams' owned entities (delivers SC8) | Draft |
| TO4 | **Ownership scorecards**: the SC5/SC6 `owner`/`on-call` checks resolve against real teams; "Unowned" fails legibly | Draft |
| TO5 | **Ownership insights**: per-team owned-entity counts, unowned-surface report, ownership coverage — the data TH's team page renders | Draft |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The owner-handle → team resolver map (account-authored metadata), read-time resolution, group-by-team on real identity, My Teams/My Services, ownership scorecards + coverage insights | Writing catalog content (forbidden by `18-state`); the team **page** itself (→ **TH**); notification routing by ownership (→ **TC**); resource/component *permissions* by team (that is access/**TG**, not ownership — ownership ≠ authorization here) |

## The critical non-goal

**Ownership is not authorization.** Resolving `owner → team` makes a team *accountable for*
and *able to find* its services; it does **not** grant the team permissions on them. Access
stays with `role_assignments` (TM) at workspace/project scope. Keeping these separate is
deliberate — it mirrors the platform's existing split (catalog = git-derived fact;
access = RBAC) and avoids turning a git string into a silent privilege grant.

## Read order

1. `README.md` — the keystone thesis + the ownership-≠-authorization non-goal.
2. `design.md` — the resolver map, read-time resolution, invariant reconciliation.
3. `implementation-plan.md` — TO1–TO5 with "done when".
4. `risks-and-open-questions.md` — map authority, owner grammar, unmapped drift.
