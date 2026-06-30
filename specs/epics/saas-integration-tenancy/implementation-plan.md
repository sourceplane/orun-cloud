# saas-integration-tenancy — Implementation Plan (IT1–IT8, + ITX IT9–IT12)

Each milestone is a candidate scope for one coherent PR-sized task. The hard
dependency is **IT1 → everything** (the dormant resolution seam), and the whole
epic depends on `saas-integrations` IG1/IG2/IG4 being live (connect, inbound,
broker) and `saas-multi-org-billing` MO1 (the `parent_org_id` seam, shipped).
Status markers reflect that nothing here is built yet.

## IT1 — Resolution seam (dormant) — 🗓️ Planned

Add `effectiveIntegrationOrg` and route connection reads through it, with **no
behavior change**.

- Add `effectiveIntegrationOrg(org) = parentOrgId ?? org.id` in the
  membership/integration repository layer (twin of
  `packages/db/src/membership/billing-scope.ts`); unit-test that it collapses to
  `org.id` for every standalone org.
- Route connection/installation **reads** in `integrations-worker` through the
  seam. Standalone orgs resolve to themselves → current behavior preserved.
- Owner: `packages/db` + `apps/integrations-worker`.
- **Done when:** the helper exists and is tested; every standalone org resolves to
  itself; no public behavior changes (integrations regression suite green); the
  seam is unread by any live multi-org path until IT2+.

## IT2 — Repo single-claim — 🗓️ Planned

Make a repo claimable by at most one workspace under a shared connection.

- Migration: partial unique `uq_integrations_repo_claim (connection_id,
  repo_external_id) WHERE status = 'active'` (see `design.md` §4); keep the
  existing `(project_id, repo_external_id)` partial unique.
- Repo-link create resolves the connection at `effectiveIntegrationOrg`; a
  workspace project links against the **account's** connection. On conflict →
  `409` with a "repository already claimed by another workspace" reason.
- Owner: `packages/db` + `apps/integrations-worker` (+ `packages/contracts` for the
  reason code).
- **Done when:** two workspaces cannot both hold an active link to one repo under
  one connection; the conflict is surfaced; existing single-org linking is
  unchanged.

## IT3 — Inbound projection — 🗓️ Planned

Attribute one delivery to the owning workspace.

- `drain.ts`: after `installation → account connection` (unchanged single-row),
  resolve the event's repo to its active `repo_link` (single-claim ⇒ ≤1) and emit
  the `scm.*` event to the **owning workspace's** org with `projectId` set.
  Unlinked repos emit account-org-scoped only (or skip) — fail closed.
- **Use a connection-keyed accessor, not the org-scoped helper.** Add
  `findActiveRepoLinkByConnectionAndRepo(connectionId, repoExternalId)`; do **not**
  reuse `listActiveRepoLinksForRepo(connection.orgId, …)` — under a shared
  connection `connection.orgId` is the account, the link is the workspace's, and
  the org-scoped helper would find nothing and silently drop the event (design §5).
- Thread the owning org through emission: the `targets` array gains `orgId` (today
  it carries only `projectId` + `environment`); append the event with
  `orgId = link.orgId`, not the hardcoded `connection.orgId`.
- Preserve exactly-once: the emission/`emitted` transaction is per owning org.
- Owner: `apps/integrations-worker` (+ `packages/db` for the accessor).
- **Done when:** a push to a repo linked by workspace W emits to W's org (not the
  account, not siblings); an unlinked repo does not leak to any workspace; replays
  remain no-ops; no code path resolves a workspace's link via the account org.

## IT4 — Token broker at the account — 🗓️ Planned

Mint from the account's installation, authorize by workspace ownership.

- Resolve the connection via `effectiveIntegrationOrg(actor.workspaceOrg)`.
- Replace the connection-org-equality assertion with active-repo-link ownership
  by the actor's workspace; keep `listActiveRepoLinksForRepo(orgId, …)`
  workspace-scoped and the GitHub scope-down (`repository_ids` + permissions
  subset) unchanged.
- Add a hard "never mint unscoped" invariant + tests (now a cross-workspace
  control).
- Owner: `apps/integrations-worker`.
- **Done when:** a workspace service principal can mint a scoped token only for
  repos it claimed under the account connection; a request for a sibling's repo is
  denied; no path can return a full-installation token.

## IT5 — Console surfaces — 🗓️ Planned

- The GitHub connection lives on the **account** (parent) Integrations page; the
  connection detail states it serves the whole account.
- Each workspace's project **Git tab** links repos against the account connection
  (repo picker reads the account installation; claimed repos are filtered out or
  shown as "claimed by «workspace»").
- Sibling visibility follows the soft default (a workspace sees its own links +
  the account-level connection status, not siblings' links).
- Owner: `apps/web-console-next` (+ `packages/sdk` if a read shape is missing).
- **Done when:** an account admin manages one connection; each workspace links its
  own repos; the shared-connection relationship is legible and the uninstall
  blast radius is disclosed.

## IT6 — Lifecycle + split-brain guard — 🗓️ Planned

- Detach rule: clearing `parent_org_id` revokes (or blocks while present) the
  workspace's active links against the account connection (decision in risks).
- Parent-side uninstall/suspend cascades to all workspaces' links/events;
  reconcile in the existing lifecycle path; audit per affected org.
- **Split-brain invariant suite (scope-aware):** assert every integration resource
  read/write resolves through `effectiveIntegrationOrg` consistently for
  `account`-scoped connections (no handler that addresses a shared connection at
  the raw workspace org), **and** that no handler resolves a `workspace`-scoped
  connection up (a private connection must stay at its workspace). This is the
  guard that keeps the platform from a half-resolved tenancy model.
- Owner: `apps/integrations-worker` + `packages/db` + a verifier task.
- **Done when:** detach is proven reversible and leaves no dangling links; a
  parent uninstall cleanly suspends the whole account's integration but leaves
  workspace-private connections running; the scope-aware split-brain suite is green
  in CI.

## IT7 — Workspace-private connections — 🗓️ Planned

Let a workspace own its own GitHub integration, independent of the account's
shared connection (design §10).

- Migration: add `connections.scope ∈ {account, workspace}`, default `account`
  (every existing row is unchanged; standalone orgs stay `account` and collapse to
  themselves). Backfill is a no-op.
- Make ownership/resolution **scope-aware** (`owningOrgFor`, design §2): the seam
  resolves up only for `account` scope; `workspace` scope is owned at
  `connection.orgId` and never resolved.
- Setup callback records scope from the initiating surface (account vs workspace
  Integrations page) via the signed connect state.
- Keystone-collision UX: when an install is already claimed, read the existing
  connection's scope and return the helpful redirect message (design §10), not the
  bare "Already connected".
- Owner: `packages/db` + `apps/integrations-worker` + `apps/web-console-next`.
- **Done when:** a workspace can connect a distinct GitHub account as a private
  connection that siblings and the account cannot see or consume; the account's
  shared connection is unaffected; standalone-org behavior is bit-for-bit unchanged;
  no path resolves a `workspace`-scoped connection up.

## IT8 — Admission control & share mode — 🗓️ Planned

Let the account govern which workspaces may consume a shared connection
(design §11).

- Migration: add `connections.share_mode ∈ {auto, granted}` default `auto`
  (back-compatible — existing connections behave as today); add
  `integrations.connection_grants (connection_id, org_id, granted_by, granted_at,
  status)` with a uniqueness on `(connection_id, org_id) WHERE status = 'active'`.
- Admission gate (`auto` ⇒ pass; `granted` ⇒ active grant required), enforced
  **before** repo-link ownership at all three touchpoints: repo-link create, the
  token broker (IT4), inbound projection (IT3). Fail closed (`403` / treat as
  unlinked). Grants may only name a child of the connection's owning account.
- Console (account): a share-mode toggle on the connection + a workspace
  admission list (grant / revoke), with the revoke→block-then-unlink rule (design
  §8, D2-shaped).
- Owner: `packages/db` + `apps/integrations-worker` + `packages/contracts` +
  `apps/web-console-next`.
- **Done when:** under `auto`, every workspace consumes as today; under `granted`,
  only admitted workspaces can claim/mint/receive; revoking admission cleanly
  unlinks (or is blocked while links exist); the gate is asserted at all three
  touchpoints by tests.

## Sequencing note

IT1 is human-independent and safe to land immediately (dormant seam, collapses to
identity for standalone orgs). IT2–IT4 are the mechanism and must land together
before any account actually shares a connection (single-claim, projection, and
broker authorization are one security story). IT5 is the credibility layer; IT6 is
the safety net + the invariant that prevents split-brain tenancy.

IT7 (workspace-private) is **independent of IT2–IT6** and nearly as safe to land
as IT1 — it adds a default-`account` column and reuses the pre-tenancy single-org
paths for `workspace` scope; it can ship any time after IT1. IT8 (admission)
**depends on IT2–IT4** because its gate stacks onto the same three touchpoints
(link create, broker, projection); land it after the core mechanism, and fold its
scope-aware assertions into the IT6 split-brain suite. Both default to today's
behavior (`scope = account`, `share_mode = auto`), so neither blocks the core
rollout — they are the governance/flexibility layer on top of it.

---

# Extended scope (ITX) — IT9–IT12

Builds on shipped IT1–IT8 (design §12) **and the now-shipped `saas-workspace-id`
(WID)** — ITX consumes WID's identity (WID4) and account RBAC (WID6) rather than
re-deriving them. No keystone/scope/tenancy change — a consumer-side + governance-
surface layer. The one new live wiring is routing the **connection list read**
through the resolver. Sequence: IT9 (badge) → IT10 (visibility) → IT11
(account-only) → IT12 (picker); IT11 may land with or just after IT10.

> **Dependency:** IT9/IT11/IT12 require WID4 (`kind`/`isAccountRoot`/`accountId`/
> `workspaceRef` on `PublicOrganization`) and WID6 (account-scoped RBAC) — both
> shipped (#246/#248). IT10 needs only IT1–IT8 + the worker-side parent resolver.

## IT9 — Account identity surface (thin) — 🗓️ Planned

WID4 already derives + surfaces `kind`/`isAccountRoot`/`accountId`/`workspaceRef`,
so the membership work is **done**. IT9 is console-only:

- Console: an "Account" chip in `sidebar-org-switcher.tsx` + the org list, from the
  existing `kind`/`isAccountRoot`; a child reads its Account name by resolving
  `accountId` against the orgs it can already see (no new endpoint).
- Owner: `apps/web-console-next` only (consumes shipped WID4 contracts).
- **Done when:** Accounts vs Workspaces are labelled on the org-list surfaces from
  WID4's `kind`; a child names its Account; standalone/account-of-one render
  sensibly.

## IT10 — Inherited shared connections — 🗓️ Planned

- Worker: add the worker-side resolver `resolveIntegrationParent` (twin of
  `resolveBillingParent`). `handleListIntegrations(orgId)` returns own connections
  PLUS — when the org is a child (`kind === 'workspace'`) — the account's
  `account`-scoped connections at `effectiveIntegrationOrg(orgId)`, flagged
  `inherited` with the account's `ws_…` + name. Under `granted`, include an
  inherited connection only if the child holds an active grant (or mark it; D7).
- Contracts: optional `inherited` + `sharedByWorkspaceRef` (`ws_…`, led-with) +
  `sharedByName` on `PublicConnection` (null/false for owned rows — back-compatible).
- Console: render inherited rows **read-only** with the *"Shared by «Account»"*
  attribution and the repo-link entry point only.
- Owner: `apps/integrations-worker` + `packages/contracts` + `apps/web-console-next`.
- **Done when:** a child sees the account's shared connection read-only and
  attributed by `ws_…`+name; a standalone org's list is unchanged; `granted`
  hides/marks unadmitted connections; the broker/projection are untouched.

## IT11 — Sharing is account-only — 🗓️ Planned

Two gates (design §12.3): position (who may *own*) + account RBAC (who may *manage*).

- Worker: connect from a **child** (`kind === 'workspace'`) is forced to `workspace`
  scope server-side (hardening IT7's surface rule); the IT8b grant/share-mode
  handlers add (a) an **Account-root-owner** structural guard and (b) an
  **account-scoped role** check (WID6 `account_admin`/`account_owner` at
  `scope_kind='account'`) → `403` otherwise. IT6 split-brain suite asserts *no
  `account`-scoped connection is owned by a child*.
- Console: gate `ConnectionAdmission` (IT5b) on **`isAccountRoot`** **and** an
  **owned** (non-inherited) connection **and** the actor's account role; child UI
  shows no share/grant/revoke affordance.
- Owner: `apps/integrations-worker` + `apps/policy-worker` (account-role check) +
  `apps/web-console-next` (consumes WID4 `kind` + WID6 roles).
- **Done when:** a child cannot create a shareable connection or call a share/grant
  endpoint; only an account-scoped admin may manage sharing; the child UI exposes
  no sharing control; an account is unchanged.

## IT12 — Grant by workspace picker — 🗓️ Planned

- Read: list the account's children (`membership.listChildOrganizations`, already in
  the repo) → `{ workspaceRef, name }`; SDK `workspaces.listChildren(account)`. Or
  derive client-side from the user's org list filtered to `accountId === account &&
  kind === 'workspace'` (WID4) — no new endpoint where the data is already present.
- Console: `ConnectionAdmission` filters out already-admitted (and the account) and
  presents a `ws_…`+name select; revoke unchanged.
- Guard: the IT8 write rule (a grant names only a child of the owning account,
  `accountId === account.workspaceRef`) stays as the server check; the grant API
  accepts `ws_…` or the `org_…` alias (WID3), led with `ws_…`.
- Owner: `packages/sdk` + `apps/web-console-next` (+ optional membership children read).
- **Done when:** an account admits a workspace by selecting it; admitted ones drop
  from the list; a non-child id is rejected server-side.
