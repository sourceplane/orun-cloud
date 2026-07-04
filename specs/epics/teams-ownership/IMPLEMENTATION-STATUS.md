# teams-ownership (TO) — Implementation Status (as-built)

Status: **✅ Shipped (TO1–TO5).** As-built record, kept distinct from the
design/plan. Additive over `teams-foundation` (TF); the catalog projection
(`state.org_catalog_entities`) is **never** written — ownership binds via an
account-authored map resolved at read time (`18-state` intact).

## TO1 — Owner-map registry ✅

- `packages/db` migration `550_membership_team_owner_handles` —
  `membership.team_owner_handles (account_org_id, owner_handle, team_id text,
  timestamps)` with an account-unique case-insensitive `lower(owner_handle)` index
  (one handle → at most one team) + a `team_id` index. Repo: `TeamOwnerHandle` +
  `upsert`/`list`/`delete`/`resolveTeamOwnerHandles` (batched IN-list, no N+1).
- `apps/membership-worker/handlers/owner-handles.ts` — account-admin CRUD (new
  `team.owner_handle.set|remove` permissions in `packages/policy-engine`),
  aliases may only point at a live team in the account (id-bound), owner strings
  normalized by stripping a `group:`/`team:` prefix (a shared normalizer keeps
  store + resolve symmetric). `team.owner_handle.set` / `.removed` audit/events.
- api-edge routes; contracts `PublicOwnerHandle`; SDK
  `listOwnerHandles`/`setOwnerHandle`/`deleteOwnerHandle`; CLI `team owner-list`/
  `owner-set`/`owner-remove`; console "Ownership aliases" panel on the team page.
- **Decisions:** TO-A account-admin authority + one-handle-one-team; TO-B strip
  prefix; TO-4 default is convention (`owner == handle` needs no row).

## TO2 — Read-time resolution ✅

- `POST /v1/organizations/:orgId/resolve-owners` (membership-worker) batch resolves
  owner strings → team identity | Unmapped | Unowned in two queries (account teams
  + alias rows for the page's keys — no N+1); order per string: normalize, match
  `owner == team.handle`, else the TO1 alias map. Account-member read gate.
- api-edge proxy; contracts `OwnerResolution`; SDK `resolveOwners`.
- `apps/web-console-next` — the catalog portal resolves the page's owners
  (batched, query-cached for TO-C bounded staleness) and stamps each service with
  its resolved team; `group-by: team` groups on real identity, search matches the
  resolved name/handle, unmapped buckets distinctly from unowned.

## TO3 — My Teams / My Services lens ✅

- `GET /v1/organizations/:orgId/my-teams` (the caller's own memberships); SDK
  `myTeams`; api-edge proxy.
- Catalog "My services" toolbar toggle (desktop + mobile) narrows to entities
  whose resolved owner team is one the viewer belongs to; Activities "My teams"
  toggle narrows the flat feed to runs in projects hosting the viewer's owned
  services (project granularity — runs carry a projectId, not a component).
  Delivers SC8.

## TO4 — Ownership scorecards ✅

- The catalog readiness `owner` check resolves against the real team: owned →
  pass; unmapped/unowned → fail, with a distinct `CheckResult.detail` remediation
  ("owner isn't mapped — add an alias" vs "no owner declared"). Rendered in the
  drawer + service page. Falls back to the prior behaviour before resolution runs.

## TO5 — Ownership insights / coverage ✅

- Pure `ownershipCoverage(services)` → owned/unmapped/unowned totals, coverage %,
  per-team owned counts, and the distinct unmapped-owner backlog — the data the TH
  team page / TG access review render. Catalog Ownership rollup counts resolved
  ownership; the catalog portal shows an unmapped-owner advisory; the team page
  shows an "N owned services" badge.

## Not in scope (per the epic boundary)

Writing catalog content (forbidden by `18-state`); the team **page** itself
(→ TH); notification routing by ownership (→ TC); team-scoped **permissions**
(ownership ≠ authorization — access stays in `role_assignments`).
