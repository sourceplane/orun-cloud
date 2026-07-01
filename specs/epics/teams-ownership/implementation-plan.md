# teams-ownership (TO) — Implementation Plan (TO1–TO5)

**Prerequisite:** `teams-foundation` **TF1** (the `team_` entity + `handle`). Consumes the
already-shipped catalog `owner` projection and the console `group-by: team` dimension. The
governing constraint: **never write catalog content** (`18-state`).

## TO1 — Owner-map registry

- `packages/db`: `membership.team_owner_handles (account_org_id, owner_handle, team_id,
  …)` with an account-unique `lower(owner_handle)` index.
- `apps/membership-worker`: CRUD for owner-handle aliases (default resolution is
  `owner == team.handle`; the map captures aliases only); `team.owner_handle.*` audit
  events; collision policy (an owner handle maps to at most one team per account).
- **Done when:** an account admin can alias legacy/aliased owner strings to a team; the
  map is account-unique and audited; the direct `owner == handle` path needs no rows.

## TO2 — Read-time resolution

- `apps/api-edge` + `apps/state-worker` read path (or a `membership` resolver binding):
  batch-resolve a page of catalog entities' `owner` → `{teamId, handle, name, avatar}` |
  `Unowned(originalString)`. **No** `team_id` column on `org_catalog_entities`.
- `apps/web-console-next`: `group-by: team` groups on resolved identity; the owner avatar
  renders the team; unmapped-owner vs no-owner render distinct copy.
- Cache per `(account, handle)` with a short TTL; invalidate on map/team-handle change.
- **Done when:** catalog rows show resolved team ownership (or a legible Unowned state);
  grouping/filtering use real team identity; resolution is batched (no N+1) and cached.

## TO3 — My Teams / My Services lens

- `packages/contracts`/`sdk` + `apps/api-edge`: a "my teams" resolution for the viewer and
  an owned-entities filter.
- `apps/web-console-next`: **My Services** filter on the catalog and a **My Teams' activity**
  filter on the flat Activities feed (join owned entities → runs via the run `component`
  ref).
- **Done when:** a viewer can filter the catalog and the activity feed to their teams'
  owned services; SC8's "My services default" is delivered.

## TO4 — Ownership scorecards

- Wire the catalog-portal `owner`/`oncall` scorecard checks to resolved teams: owned-by-a-
  real-team passes; unmapped-owner and no-owner fail with distinct remediation copy.
- **Done when:** scorecards reflect real ownership; the "who owns this" check is honest.

## TO5 — Ownership insights / coverage

- Compute per-team owned-entity counts, the unowned/unmapped action list, and account-level
  ownership coverage %.
- **Done when:** an account admin can see ownership coverage and the unmapped-owner backlog;
  the per-team counts are exposed for the **TH** team page to render.

## Sequencing note

TO1 → TO2 is the resolver critical path (the keystone). TO3 (lens) and TO4/TO5
(scorecards/coverage) follow resolution. TO is the hard prerequisite for **TH** (team page
renders owned services + coverage) and feeds **TC** (route events to the owning team).
