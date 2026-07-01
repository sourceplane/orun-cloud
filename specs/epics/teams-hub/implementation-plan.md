# teams-hub (TH) — Implementation Plan (TH1–TH5)

**Prerequisites:** `teams-foundation` **TF** (entity + members + provenance) and
`teams-ownership` **TO** (owner→team resolution + coverage). Governing decision: **thicken
the account surface, never deepen the tree.**

## TH1 — Account Hub surface

- `apps/web-console-next`: an account-scoped console area (Overview · Workspaces · Members ·
  Roles · Teams · Usage), reached from the Account chip (WID5 badge).
- `apps/membership-worker` + `apps/api-edge`: finish WID6's deferred account-role **list +
  revoke** (grant already exists); the derived **account-member roster** (§2 of design — no
  new table).
- **Done when:** an account admin has a real account home; account-role grant/list/revoke
  all work from the console; the account-member roster (incl. cascade admins) is visible.

## TH2 — Cross-workspace read layer

- `apps/api-edge` + `apps/state-worker`: account-scoped aggregation that fans out over the
  account's Workspace set (`list-account-workspaces`) across the per-org catalog/run
  indexes, tagged by workspace, bounded (concurrency + per-page workspace cap; paginate by
  workspace for large accounts).
- **Done when:** a caller can read "catalog entities / runs across this account" with a
  bounded, paginated fan-out; no new denormalized cross-workspace store is introduced.

## TH3 — Team Page

- `apps/web-console-next` + `packages/contracts`/`sdk`: the team page — identity + members
  (TF) + owned services across workspaces (TO + TH2) + coverage (TO5) + access-with-
  provenance (TF4).
- **Done when:** a team has a page showing who's on it, what it owns (across workspaces),
  and what it can do; unowned/unmapped items surface as a team backlog.

## TH4 — Team activity/deploy rollup

- Join the team's owned entities → runs via the run `component` ref; render recent
  runs/deploys/health on the team page (rides SC2/SC3 as they land; degrade gracefully
  before then).
- **Done when:** the team page shows the owned services' recent deploy/run activity; absent
  SC2/SC3 data degrades to "no recent activity" rather than erroring.

## TH5 — Multi-workspace grant management

- `apps/web-console-next` + `apps/api-edge`: from the account, grant a team a role on a
  **selected set** of workspaces (multi-select over the IT12 picker), or one account-scope
  grant for "all incl. future".
- **Done when:** an account admin can grant a team access to a chosen set of workspaces in
  one flow; the account-scope "all" option is offered distinctly; every write is audited.

## Sequencing note

TH1 (surface) + TH2 (fan-out) are the foundation; TH3/TH4 (team page) render over them;
TH5 (grant management) can land with TH1. TH consumes TO and feeds nothing downstream
except that its on-call panel renders **TC**'s data read-only.
