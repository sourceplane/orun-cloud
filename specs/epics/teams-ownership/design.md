# teams-ownership (TO) — Design

Status: Draft. Written against repo reality as of 2026-07-01: the catalog projection
`state.org_catalog_entities` carries a git-authored `owner TEXT` (migration
`330_state_org_catalog_index` / `370_state_catalog_portal_fields`); the console groups by
it (`apps/web-console-next/src/lib/catalog-portal/filter.ts` — `group-by: team`); the
portal renders an owner avatar + an "Unowned" state; SC8 plans a "My services" filter.
The catalog read-model is **derived, never authored** (`specs/components/18-state.md`).

## 1. The reconciliation — bind without authoring

Two facts are in tension:

- The `owner` string is **git-authored** and flows `orun catalog push` → snapshot →
  projected read-only. The console **may not** write it.
- A Team is a **console/account-authored entity** (`team_…`, TF).

Backstage solved the identical tension: `spec.owner: group:payments` in git resolves to a
`Group` entity via the catalog graph. We do the same with an **account-authored mapping**
that lives *outside* the catalog projection:

```sql
-- membership.team_owner_handles — account-authored map: git owner handle → team entity.
-- This is ORG METADATA, not catalog content, so the 18-state invariant is intact:
-- the catalog projection (state.org_catalog_entities) is never written.
CREATE TABLE membership.team_owner_handles (
  account_org_id  UUID NOT NULL,     -- owning account
  owner_handle    TEXT NOT NULL,     -- the string as it appears in git `owner:`
  team_id         TEXT NOT NULL,     -- resolves to membership.teams.id (team_…)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_org_id, lower(owner_handle))
);
```

By default `owner_handle` == the team's `handle` (TF1), so most teams need **no explicit
map row** — resolution first tries `owner == teams.handle`, and the map table only exists
to capture **aliases** (legacy owner strings, `group:payments` forms, renames, several
strings pointing at one team). The map is small, account-scoped, audited, and — crucially
— it is the *only* new authored surface; the catalog projection is untouched.

## 2. Read-time resolution (TO2) — no denormalized team_id

Resolution happens **at read**, never by stamping `team_id` onto the projection (a
denormalized column would drift on every re-projection and re-introduce an authored field
into a derived table). For a catalog entity with `owner = s`:

```
resolveOwner(account, s):
  if s is null/empty        → Unowned
  h = normalize(s)          # strip an optional 'group:' prefix (TO-B), lower-case
  team = teams where account_org_id=account and lower(handle)=h        # direct
       ?? team_owner_handles where account_org_id=account and lower(owner_handle)=h  # alias
  return team ? {teamId, handle, name, avatar} : Unowned(originalString)
```

- **Unowned** keeps the original git string so the portal can show "owner declared but
  unmapped: `foo`" distinctly from "no owner declared" — both render the portal's dashed
  "Unowned" avatar but the copy differs (an unmapped owner is an *action item*, surfaced
  in TO5's coverage report).
- `group-by: team` (already in `filter.ts`) switches from grouping on the raw string to
  grouping on the resolved `{teamId, name}` — same UI, real identity underneath.
- Resolution is a batched lookup over the entities on the page (no N+1); cache per
  `(account, handle)` with a short TTL invalidated on map or team-handle change (TO-C).

## 3. My Teams / My Services (TO3) — the lens

This is the "what's ours?" payoff and it fixes a concrete gap: the **Activities** feed is
flat and org-wide today (`apps/web-console-next/.../activities/page.tsx` — no "my work").

- **My Teams** = `team_members where subject_id = viewer` (TF).
- **My Services** = catalog entities whose resolved owner ∈ My Teams.
- Apply the same predicate to the Activities feed → **My Teams' runs/deploys** (a run
  carries an optional `component` ref — `packages/contracts/src/state.ts`; join owned
  entities → their runs).
- Ships SC8 ("My services default, filter by the viewer's owned teams once SC6 lands")
  with the resolver providing the missing "once teams land" half.

## 4. Ownership scorecards + coverage (TO4, TO5)

- The catalog-portal scorecard already has `owner`/`oncall` checks (`fail` when absent).
  TO4 makes the `owner` check resolve against a **real team** — "owned by `@payments`"
  passes; "owner: foo (unmapped)" and "no owner" both fail, with distinct remediation.
- TO5 computes **ownership coverage**: per-team owned-entity counts, the unowned/​unmapped
  surface (the action list), and account-level coverage %. This is precisely the data the
  **TH** team page and the **TG** access-review render — compute it once, here.

## 5. Why read-time + a map (alternatives rejected)

- **Denormalize `team_id` onto `org_catalog_entities`** — rejected: violates
  derived-never-authored, drifts on re-projection, couples the catalog projector to the
  membership context. The map + read-time resolution keeps the two contexts clean.
- **Make `owner` an RBAC grant** — rejected: ownership ≠ authorization (README non-goal);
  it would turn a git string into a silent privilege escalation.
- **Force `owner` to be a `team_` id in git** — rejected: hostile to authors (ids are not
  human), brittle across renames, and it leaks an internal id into source. A human handle
  in git + an account-owned alias map is the ergonomic, rename-safe choice.
- **Resolve in the catalog projector (state-worker)** — rejected: the projector is in the
  `state` context and must stay git-only; ownership resolution is a `membership`/read
  concern. Resolve at the read/edge or via a membership lookup, not in the projector.
