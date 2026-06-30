# Epic: saas-integration-tenancy

**One GitHub App installation serves a whole account — the parent org and every
workspace under it.** GitHub allows exactly one App installation per GitHub
account, but a single customer may run several Orun Cloud organizations
(workspaces) under one parent. This epic resolves that cardinality mismatch by
making the **parent (account) org the integration tenant boundary** — mirroring
the way `saas-multi-org-billing` already makes the parent the *billing* boundary.
The connection resolves **up** to the parent; workspaces consume it for their own
repo links and events. The `installation_id ↔ connection ↔ org` keystone from
`saas-integrations` is preserved untouched — there is still exactly one
connection per installation, owned by the account.

A connection now carries an explicit **ownership scope** — *account-shared* (the
case above) or *workspace-private* (a workspace's own GitHub account, owned at the
workspace and **never** resolved up). And every account-shared connection carries
a **share mode** — `auto` (default; every workspace under the account may consume
it, today's soft behavior) or `granted` (the account admits workspaces one by one).
Both are additive: the seam resolves *up* only for `account`-scoped connections,
and `auto` is the back-compatible default, so nothing about the headline case
changes. These two refinements answer the two questions the original draft left
implicit — *"can a workspace bring its own integration?"* (yes, workspace-private)
and *"can the account govern who shares the connection?"* (yes, share mode +
admission grants).

## Status

| Field | Value |
|-------|-------|
| Status | **IT1–IT8 shipped** (core tenancy mechanism + admission live; detach guard tracked in #239). **Extended scope (IT9–IT12) — Draft**: shared-integration visibility & account-only governance. |
| Cluster | **IT** (integration tenancy — bridges **IG** `saas-integrations` and **MO** `saas-multi-org-billing`) |
| Owner(s) | `apps/integrations-worker` + `packages/db` + `apps/api-edge` + `apps/web-console-next` (+ `packages/contracts`/`sdk`) |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `saas-integrations/design.md` §4 (tenancy keystone) + §6 (inbound pipeline) + §7 (token broker); `saas-multi-org-billing/design.md` §4 (`effectiveBillingOrg` resolution seam) + §5 (fan-out); `packages/db/.../180_integrations_foundation`; `packages/db/src/membership/billing-scope.ts`. **Extended scope (ITX) also builds on `saas-workspace-id` (WID):** `PublicOrganization.{workspaceRef, accountId, kind, isAccountRoot}` (WID4), account-scoped RBAC `account_admin`/`scope_kind='account'` (WID6), the `ws_…` led-with handle (WID2/WID5), and the account config scope-resolution chain (WID7, sibling of `effectiveIntegrationOrg`). |
| Decisions locked | Structural: (1) the **integration tenant boundary is the parent (account) org** for *account-shared* connections, resolved by a new `effectiveIntegrationOrg(org) = parentOrgId ?? org.id` seam (twin of `effectiveBillingOrg`); (2) the **credential is resolved UP, never fanned out** — you cannot copy a live installation, so the connection is owned at the parent and read through the seam (entitlements still fan **down** unchanged); (3) the `installation_id` UNIQUE → one-connection keystone is **preserved** — no constraint is relaxed; (4) sibling isolation defaults to **soft** — workspaces share the account's connection and what each sees is scoped by project/policy, mirroring how children already share a billing customer; (5) a connection carries an **ownership scope** (`account` \| `workspace`) — the seam resolves up *only* for `account`-scoped connections, so a **workspace-private** connection stays at the workspace (A5); (6) account-shared connections carry a **share mode** (`auto` default \| `granted`) plus an **admission grant** list, so the account governs which workspaces may consume the connection (A6). |
| Gate | IT1 (the dormant resolution seam) is human-independent and back-compatible. IT2+ live paths need `saas-integrations` IG1/IG2/IG4 landed (connect, inbound, broker) and a registered GitHub App per env. The open product decision — **soft vs hard sibling isolation** (D1) — is registered in `risks-and-open-questions.md` (default: soft). Ownership scope (A5) and share mode (A6) are decided with back-compatible defaults; their finer knobs (grant granularity D5) stay open there. |

## Thesis

`saas-integrations` made the org the integration boundary: an installation binds
to one org via signed state, and `github_installations.installation_id` is
globally `UNIQUE`, so one GitHub install = one connection = one org. That is the
right invariant — until a single customer owns more than one org. GitHub will
only ever issue **one** installation for their GitHub account, so a second
workspace that tries to connect the same account is refused ("Already
connected"). The friction is not a bug; it is a cardinality mismatch between
GitHub's tenant unit (the GitHub account) and ours (the org).

`saas-multi-org-billing` already solved the same mismatch for billing without
restructuring anything: it added one nullable `parent_org_id` and a single
resolution rule, `effectiveBillingOrg(org) = parentOrgId ?? org.id`, and made the
payment provider's customer the **parent** (`customerExternalId = parentOrgId`).
Billing reads resolve up; entitlements fan down. We do the exact same move for
integrations. The GitHub App installs once onto the customer's GitHub account and
binds to their **account (parent) org**; the connection is owned there; every
workspace under the account resolves to it for repo links, scoped tokens, and
events. The keystone never moves — there is still one connection per
installation — it just lives at the account, where billing already does.

## How it maps to `saas-multi-org-billing` (the reference)

| Billing (shipped) | Integrations (this epic) |
|-------------------|--------------------------|
| `effectiveBillingOrg(org) = parentOrgId ?? org.id` | `effectiveIntegrationOrg(org) = parentOrgId ?? org.id` (twin seam) |
| Payment provider customer = the **parent** (`customerExternalId = parentOrgId`) | GitHub installation/connection owned by the **parent** (account) |
| Billing **reads** resolve up to the parent | Connection / installation / brokered-token **reads** resolve up to the parent |
| Entitlements **fan down** into each child's own `(org_id, key)` rows | `feature.integrations.github` **already** fans down — unchanged |
| Usage **rolls up**: parent view sums children's `metering` rollups | Inbound events **project down**: one delivery emits to the owning workspace's org |

## Read order

1. `README.md` (this file) — status + thesis + the connection ownership model +
   milestones-at-a-glance.
2. `design.md` — the resolution seam, what resolves up vs down, repo single-claim,
   webhook projection, the token broker change, authorization, lifecycle,
   workspace-private connections (§10), admission control & share mode (§11).
3. `implementation-plan.md` — IT1–IT8, each with "done when".
4. `risks-and-open-questions.md` — soft-vs-hard sibling isolation, detach
   behavior, the split-brain-tenancy guard, and the ownership-scope / share-mode
   decisions (A5/A6) with their open sub-questions.
5. `design.md` §12 — **Extended scope (ITX)**: account-workspace identity,
   inherited shared connections, account-only sharing, the workspace picker.

## Connection ownership model (the one diagram to hold in your head)

Every connection answers one question — *which org owns this credential, and who
may consume it?* There are exactly three shapes, and the keystone
(`installation_id` UNIQUE) guarantees they never collide on the same GitHub
account:

| Shape | `connection.scope` | Owner org | Resolved by `effectiveIntegrationOrg`? | Who may consume |
|-------|--------------------|-----------|----------------------------------------|-----------------|
| **Standalone** (today) | `account`¹ | the org itself (`parentOrgId` is NULL) | yes, collapses to `org.id` | the org |
| **Account-shared** | `account` | the parent (account) org | **yes**, resolves up to the parent | workspaces per **share mode** (`auto`: all; `granted`: admitted only) — §11 |
| **Workspace-private** | `workspace` | the workspace itself | **no** — stays at the workspace, invisible to siblings & the account | that workspace only |

¹ A standalone org and an account both use `scope = 'account'`; the difference is
purely whether `parentOrgId` is set, exactly as billing already distinguishes them.
The scope value only ever reads `workspace` for a deliberately private connection.

**Decision rule at connect time:** *where you click decides ownership.* Connecting
from the **account** Integrations page mints an `account`-scoped connection (shared);
connecting from a **workspace** Integrations page mints a `workspace`-scoped one
(private). If a workspace tries to connect a GitHub account the account already
holds, the keystone refuses — but with a helpful "already connected at the account;
use the shared connection" instead of a dead end (§10).

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| IT1 | Resolution seam (dormant): `effectiveIntegrationOrg` + route connection reads through it — collapses to `org.id` for standalone orgs, **no behavior change** | ✅ Shipped |
| IT2 | Repo single-claim: a repo under a shared connection is claimable by one workspace/project; workspace links repos against the account's connection | ✅ Shipped |
| IT3 | Inbound projection: `drain.ts` attributes `installation → account connection → owning workspace org`, exactly-once per workspace | ✅ Shipped |
| IT4 | Token broker at the account: resolve the connection via `effectiveIntegrationOrg`, authorize by workspace repo-link ownership, scope token per repo (unchanged scope-down) | ✅ Shipped |
| IT5 | Console: connection lives on the **account**; scope / admission / uninstall blast-radius legible on the Integrations surface | ✅ Shipped |
| IT6 | Lifecycle: scope-aware split-brain invariant suite + uninstall cascade; detach data primitive (`countActiveSharedRepoLinks`) | ✅ Shipped (detach *guard* wiring tracked in #239) |
| IT7 | Workspace-private connections: `connection.scope` column; the seam resolves up only for `account` scope; workspace Integrations surface; keystone-collision UX | ✅ Shipped |
| IT8 | Admission control & share mode: `share_mode` (`auto`\|`granted`) + `connection_grants` allow-list; admission gate at the broker; grant-management API (IT8b) + account grant UI (IT5b) | ✅ Shipped |

### Extended scope — shared-integration visibility & governance (ITX)

A second wave that makes the account/workspace hierarchy **legible** and the
sharing relationship **one-directional and well-attributed**: a workspace *sees*
the connection it inherits (read-only, with provenance), and only the **account
workspace** can *share* it. Builds entirely on IT1–IT8; no keystone or tenancy
change — this is the consumer-side and governance-surface layer.

> **Reconciled with `saas-workspace-id` (WID), 2026-06-30.** WID4 already ships
> `kind`/`isAccountRoot`/`accountId`/`workspaceRef` on `PublicOrganization`, and
> WID6 ships account-scoped RBAC — so ITX **consumes** them: IT9 thins to a console
> badge, IT11 rides on account RBAC, IT12 leads with `ws_…`. See design §12 (top
> note).

| ID | Milestone | Status |
|----|-----------|--------|
| IT9 | **Account identity surface** (thin — consumes WID4): the console badges the **Account** in the org switcher from the existing `kind`/`isAccountRoot`; a child names its Account via `accountId`. No membership/derivation work (WID4 did it) | 🗓️ Planned |
| IT10 | **Inherited shared connections**: a child workspace's Integrations list resolves *up* and shows the account's `account`-scoped connections **read-only**, attributed *"Shared by «Account» (`ws_…`)"*; sibling of WID7's config scope-resolution chain | 🗓️ Planned |
| IT11 | **Sharing is account-only**: only an **Account root** can own an `account`-scoped connection (child connects forced to `workspace`); managing `share_mode`/grants requires an **account-scoped role** (WID6 `account_admin`); the child UI shows **no** share controls | 🗓️ Planned |
| IT12 | **Grant by workspace picker**: the account admits workspaces by selecting from its **child workspaces** (`ws_…` + name), filtered to the not-yet-admitted — replacing IT5b's free-text id | 🗓️ Planned |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The `effectiveIntegrationOrg` resolution seam; connection ownership scope (`account` \| `workspace`); workspace-private connections (IT7); repo single-claim; webhook projection to workspaces; the token-broker resolution + authorization change; **admission control & share mode** (IT8); the console surfaces; the detach/uninstall lifecycle rules; the split-brain guard. **Extended (ITX):** account-workspace identity on the org list; inherited (read-only) shared connections with provenance; account-only sharing; the workspace-picker grant surface | The base connect/inbound/broker mechanics (owned by `saas-integrations` IG1/IG2/IG4 — consumed as-is); the parent/child org primitive + entitlement fan-out (owned by `saas-multi-org-billing` — consumed as-is); the **Workspace** rebrand of the noun (→ `saas-workspaces`); **hard, role-based** cross-workspace RBAC (a `components/04` follow-up — admission here is a resolution-layer grant list, not hierarchical roles, A4); pooled quotas; a **detach** operation (none exists yet — #239); cross-workspace *transfer/move* of a connection |

## Relationship to existing work

- **`saas-integrations` (IG)**: this epic does not change the connect/ingress/
  broker mechanics; it changes *which org owns the connection* (the account) and
  *how the connection is reached* (resolution). The `installation_id` keystone and
  the scoped-token broker are reused intact.
- **`saas-multi-org-billing` (MO)**: hard dependency on the shipped MO1 seam
  (`parent_org_id`, `effectiveBillingOrgId`). This epic is its integrations twin —
  same lazy, additive, back-compatible discipline.
- **`saas-workspaces` (WS)**: orthogonal. The tenancy reframing here works
  identically whether the units are called "sub-orgs" or "Workspaces"; WS is the
  presentation/API vocabulary, IT is the mechanism. They can land in either order.
- **`saas-workspace-id` (WID)**: the **Extended scope (ITX) depends on it.** WID
  shipped the identity substrate ITX consumes — `PublicOrganization.{workspaceRef,
  accountId, kind, isAccountRoot}` (WID4), account-scoped RBAC (`account_admin`,
  `scope_kind='account'`, cascade — WID6), the led-with `ws_…` handle (WID2/WID5),
  and the account config scope-resolution chain (WID7). Net effect: **IT9's
  derivation is already done by WID4** (IT9 reduces to a console badge), **IT11's
  "account-only" rides on WID6 account RBAC** (not a bespoke gate), and **IT12 leads
  with `ws_…`**. IT1–IT8 (shipped) predate WID and are unaffected — they use
  `effectiveIntegrationOrg` over `parent_org_id` directly.
- **`saas-teams` (TM)**: orthogonal. A grant currently names a **workspace**, not a
  team principal; admitting a team is a deferred, additive option (design §12.5).
- **`oidc-ci-tenancy` (CLI) / `saas-orun-platform`**: the Orun CLI's tenancy claim
  (`intent.yaml execution.state.workspace`, aliasing the shipped
  `execution.state.org`, orun #420 — see `saas-workspaces` A4) and the
  `state.workspace_links` CI allow-list are a **separate subsystem** from the
  GitHub connection this epic re-points. They stay **workspace-scoped** and are
  *not* subject to `effectiveIntegrationOrg` (design.md §9). The two link tables —
  `integrations.repo_links` (here) and `state.workspace_links` (CLI/state) — are
  distinct and must not be conflated.
