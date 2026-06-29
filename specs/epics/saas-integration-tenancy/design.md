# saas-integration-tenancy — Design

Status: Draft (normative once IT1 lands)

How one GitHub App installation serves a parent (account) org and all the
workspaces under it, without moving the `saas-integrations` tenancy keystone and
without poking a hole in the per-org isolation model. Written against repo
reality as of 2026-06-29 (`saas-integrations` IG0 shipped; `saas-multi-org-billing`
MO1 seam shipped: `membership.organizations.parent_org_id` +
`packages/db/src/membership/billing-scope.ts`).

## 1. The problem, precisely

`saas-integrations` binds an installation to one org and enforces it in the
schema (`packages/db/.../180_integrations_foundation/up.sql`):

```sql
CREATE UNIQUE INDEX uq_integrations_github_installation
  ON integrations.github_installations (installation_id);
CREATE UNIQUE INDEX uq_integrations_github_installation_connection
  ON integrations.github_installations (connection_id) WHERE connection_id IS NOT NULL;
```

The setup callback refuses to re-point an installation already claimed by another
connection (`apps/integrations-worker/src/handlers/setup.ts` — "an installation
already claimed by another connection must not flip" → *"Already connected"*).
This is correct single-org behavior. It breaks only when **one customer owns more
than one org**: GitHub issues exactly one installation per GitHub account, so the
customer's second org can never claim it.

The root cause is a **cardinality mismatch**: GitHub's tenant unit is the GitHub
account; ours is the org; a customer maps one GitHub account to several orgs. The
fix is to realign our integration tenant unit to the customer's account — which
the platform already models as the **parent org**.

## 2. The decision: the parent org is the integration tenant

Adopt the billing seam verbatim, for integrations:

```ts
// packages/db/src/membership/integration-scope.ts  (twin of billing-scope.ts)
export function effectiveIntegrationOrg(
  org: Pick<Organization, "id" | "parentOrgId">,
): string {
  return org.parentOrgId ?? org.id;
}
```

- For every **standalone** org (`parentOrgId === null`) this collapses to
  `org.id` — current behavior is preserved bit-for-bit, exactly as
  `effectiveBillingOrg` does. The seam is dormant until a customer owns a parent.
- The GitHub App installs onto the customer's GitHub account and binds to their
  **account (parent) org**. `connections` / `github_installations` rows for the
  installation are owned at `effectiveIntegrationOrg(org)`.
- The keystone is **unchanged**: `installation_id` stays globally `UNIQUE`; there
  is still exactly **one connection per installation**, owned by the account. We
  are not relaxing a constraint — we are choosing *which org* owns the single
  connection (the account, not an arbitrary workspace).

The seam is **scope-aware**, not unconditional. A connection carries
`scope ∈ {account, workspace}` (IT7, §10). The resolution rule applies **only to
`account`-scoped connections**; a `workspace`-scoped (private) connection is owned
by the workspace and is never resolved up. Concretely the read path is:

```ts
// integrations-worker connection read (IT7)
function owningOrgFor(conn: Connection, actorOrg: Organization): string {
  return conn.scope === "workspace"
    ? conn.orgId                          // private: stays at the workspace
    : effectiveIntegrationOrg(actorOrg);  // shared: resolves up to the account
}
```

For every standalone org this still collapses to `org.id` regardless of scope, so
the dormant-by-default property (IT1) is untouched.

## 3. What resolves UP vs what fans DOWN

The billing epic uses two complementary moves; integrations uses the same split,
and the split matters:

| Thing | Direction | Why |
|-------|-----------|-----|
| **Connection / installation** | **Resolve UP** to the parent | It is a live credential. You cannot copy an installation token into each child, and you must not mint a second GitHub installation. One row, owned by the account, read through the seam. |
| **Brokered token reads** | **Resolve UP** | The broker mints from the account's installation, scoped down per repo (§6). |
| **`feature.integrations.github` entitlement** | **Fans DOWN** (already) | `saas-multi-org-billing` MO3 fan-out already copies the parent's entitlements into each child's `(org_id, key)` rows, so the gate reads the workspace's own row, unchanged. |
| **Inbound `scm.*` events** | **Project DOWN** | One delivery is attributed to the account connection, then emitted to the **owning workspace's** org (§5), analogous to billing's usage roll-up read. |

**Rule of thumb:** the *credential* resolves up; the *entitlement* fans down; the
*events* project down. Do not attempt to fan out the connection — that is the one
place the billing analogy inverts.

This table describes **`account`-scoped** connections. A **workspace-private**
connection (§10) short-circuits every row: it is owned at the workspace, so there
is nothing to resolve up, nothing to project down, and no sibling to isolate from —
it behaves exactly like a standalone single-org connection, because that is what it
is. Admission (§11) sits *above* this table for shared connections: it decides
*whether* a workspace reaches the resolved connection at all, before repo-link
ownership decides *which repos* it may use.

## 4. Repo links and single-claim (IT2)

A `repo_link` binds a repo to a **project** (for branch→environment mapping) and
carries `org_id, project_id, connection_id`. Under a shared connection, links are
still owned at the **workspace** level — a workspace's project links a repo
against the **account's** connection (`connection_id` points at the account
connection; `org_id`/`project_id` are the workspace's).

Today the only uniqueness is partial on `(project_id, repo_external_id)` — it does
**not** stop two different workspaces from linking the same repo. Under a shared
connection that would mean two workspaces receive the same repo's events and can
both mint tokens for it. IT2 adds a **single-claim** constraint:

```sql
-- A repo under a given connection is claimable by at most one active link.
CREATE UNIQUE INDEX uq_integrations_repo_claim
  ON integrations.repo_links (connection_id, repo_external_id)
  WHERE status = 'active';
```

This is now **intra-account coordination** (two workspaces of one customer must
not both claim a repo), not cross-tenant isolation — much lower stakes, and the
"first claim wins / explicit reassignment" UX is a product nicety, not a security
boundary. The existing `(project_id, repo_external_id)` partial unique stays
(stops one project double-linking).

## 5. Inbound projection (IT3)

Today `drain.ts` attributes `installation.id → github_installation → connection →
org` as a single-row lookup and emits to that one org. With the connection at the
account, the attribution becomes a **projection across the account's workspaces**:

1. `installation.id → github_installations (UNIQUE) → account connection` —
   unchanged single-row lookup; the keystone still holds.
2. For the event's repo, find the **active `repo_link`** under that connection
   (single-claim guarantees ≤1). Its `org_id`/`project_id` is the owning
   workspace.
3. Emit the normalized `scm.*` event to the **owning workspace's** org (with
   `projectId` set). A repo with no active link emits **account-org-scoped only**,
   or is skipped — fail closed, exactly as orphaned/unlinked events are today.

This preserves **exactly-once emission**, now phrased as "exactly once to the org
that owns the repo's link." It is a within-account projection — the same shape as
billing's "parent usage view sums children's rollups," read in the opposite
direction. No cross-tenant fan-out, because there is only one tenant (the
account).

**Implementation correctness note — the accessor must be connection-wide, not
org-scoped.** Today `drain.ts` resolves links with the workspace-scoped
`listActiveRepoLinksForRepo(connection.orgId, repoExternalId)`. Under a shared
connection `connection.orgId` is the **account**, but the link is owned by a
**workspace**, so that helper would find nothing and the event would silently fail
to route. IT3 must introduce a connection-keyed accessor —
`findActiveRepoLinkByConnectionAndRepo(connectionId, repoExternalId)` — that
returns the single active link regardless of which workspace owns it (single-claim
guarantees ≤1). The emit path must then thread the **link's `org_id`** through the
`targets` array (it currently carries only `projectId` + `environment`) and append
the event with `orgId = link.orgId`, not the hardcoded `connection.orgId`. Reusing
the org-scoped helper with the account org is the most likely way to reintroduce
the very misrouting this milestone fixes.

## 6. Token broker at the account (IT4)

The broker (`apps/integrations-worker/src/handlers/token-broker.ts`) already does
the security-critical work: it validates every requested repo against an **active
repo link the actor's org can access**, requires all repos resolve to one
connection, and mints a token **scoped down** by GitHub to exactly those
`repository_ids` + a permissions subset (`createScopedInstallationToken`,
`apps/integrations-worker/src/github-app.ts`). Two changes:

- **Resolve the connection via `effectiveIntegrationOrg`.** A workspace actor's
  `actor.orgId` is the workspace; the connection lives at the account. Look up the
  connection at `effectiveIntegrationOrg(workspaceOrg)`.
- **Authorize by repo-link ownership, not connection-org equality.** Replace the
  "connection.org must equal actor.org" assertion with "the actor's workspace owns
  an active `repo_link` (on the account connection) for each requested repo."
  Because `listActiveRepoLinksForRepo(orgId, …)` is already workspace-scoped, a
  workspace can still only mint for repos **it** claimed — single-claim makes that
  unambiguous.

The token is still minted fresh, scoped to specific repos, never cached, never
logged — unchanged. The **maximum** scope (all account-selected repos) is shared,
so "never mint unscoped" becomes a cross-workspace invariant with its own tests
(§ risks): a scoping regression that previously leaked within one org would now
leak across workspaces of the same account.

When admission control (§11) is in force (`share_mode = 'granted'`), the broker
adds one check **before** repo-link ownership: the actor's workspace must hold an
active grant on the connection. This is a cheap allow-list lookup, not a policy
change — it fails closed (no grant ⇒ `403`, identical to an unauthorized repo) and
collapses to a no-op under the `auto` default.

## 7. Authorization (the key non-hole)

The platform's isolation rests on exact-match policy: `f.scope.orgId === orgId`
(`packages/policy-engine/src/index.ts`). This epic does **not** add a
hierarchical-role exception. Instead, integration **resources are addressed at
their effective integration org** — a *resolution rule*, identical in shape to
billing resolving reads to the parent. Concretely:

- A workspace member calling an integration endpoint is authorized against the
  **workspace** (their real membership, exact-match, unchanged).
- The endpoint then **resolves the connection** at `effectiveIntegrationOrg` and
  serves the account-owned connection. The workspace never gains a *role* in the
  parent; it gains a *resolved view* of the account's connection, gated by its own
  repo-link ownership.

This keeps the exact-match invariant intact everywhere and confines the new
behavior to a documented resolution seam — the same trust the platform already
extends to `effectiveBillingOrg`.

### Sibling isolation: soft by default

Workspaces under one account **share** the connection the way they already share
a billing customer and pooled usage. What each workspace *sees* (repos, events,
tokens) is scoped by **repo-link ownership + project/policy**, not by a tenancy
wall. Hard isolation between siblings (workspace A's repos invisible to workspace
B even within the account) is a registered, non-default option (see risks) that
would re-introduce per-workspace claim walls and stricter fan-out.

## 8. Lifecycle (IT6)

- **Detach** (`clear parent_org_id`, billing-reversible): the workspace becomes
  standalone and no longer resolves to the account's connection. Its active
  `repo_links` against the account connection must be **revoked** (or detach is
  **blocked** while links exist) — chosen in risks. No data migration; the
  connection itself is untouched.
- **Parent-side GitHub uninstall / suspend**: an account-level event. It
  cascades to **every** workspace's links and events (they all hang off the one
  installation). The console danger-zone and connection detail must state this
  plainly ("uninstalling removes GitHub for this account and all its workspaces").
- **Promotion**: a standalone org "becomes an account" the moment it gains a child
  — no integration row rewrite, exactly as billing promotion needs none.
- **Workspace-private connections are unaffected by account-level events.** A
  parent-side uninstall/suspend cascades only to the **account-shared** connection
  and its consumers; a workspace's private connection (its own GitHub account) is a
  separate installation and keeps working. Symmetrically, detaching a workspace
  does not touch its private connection — only its links *against the account*
  connection follow the detach rule above. This is a feature: a team can keep its
  own integration through an account reorganization.
- **Grant revocation** (§11, `granted` mode): when the account revokes a
  workspace's admission, that workspace's active `repo_links` against the shared
  connection must be revoked (or revocation blocked while links exist) — the same
  block-then-unlink shape chosen for detach (D2), surfaced in the console.

## 9. What deliberately does NOT change

- No second GitHub App, no second installation, no relaxed `installation_id`
  uniqueness — the keystone is sacred.
- No fan-out (copying) of connections or tokens — credentials resolve up only.
- No change to `check-entitlement` — `feature.integrations.github` already fans
  down per MO3.
- No change to the scoped-token mint path — only *which connection* it resolves
  and *how access is authorized*.
- No hierarchical RBAC — authorization stays exact-match; only resource
  *addressing* resolves to the account. Admission (§11) is a resolution-layer
  allow-list, not a role: it gates *whether* a workspace reaches the shared
  connection, never granting it a role in the parent.
- The resolution seam stays **scope-aware** — applied to `account`-scoped
  connections only. A handler that resolves a `workspace`-scoped connection up
  would be a split-brain bug; the IT6 suite asserts against it (§ implementation).
- **No change to the CLI / state tenancy claim.** The Orun CLI's committed claim
  (`intent.yaml execution.state.workspace`, aliasing the shipped
  `execution.state.org`; `--workspace`/`--org`, `ORUN_WORKSPACE`/`ORUN_ORG` — see
  `saas-workspaces` A4) and the state allow-list it gates on
  (`state.workspace_links`, keyed `(org, project=repo)`) are the **workspace's own
  org** and stay so. `effectiveIntegrationOrg` resolves *only* the GitHub
  **connection** up to the account — it must **not** be applied to the CLI claim or
  to `state.workspace_links`. Two different "links" live in two subsystems and
  must not be conflated: `integrations.repo_links` (this epic — a workspace's repo
  claims against the **account** connection) versus `state.workspace_links` (the
  CLI/CI allow-list — workspace-local, never resolved up). Resolving the CLI claim
  up would be a split-brain in the wrong direction (it would let one workspace's CI
  claim land in a sibling's or the account's state scope). The IT6 split-brain
  suite (§ implementation-plan) asserts the seam is applied to the *connection*
  path only.

## 10. Workspace-private connections (IT7)

The blanket "every connection resolves up" rule of the original draft answered the
shared case but quietly foreclosed a legitimate one: a workspace that wants its
**own** GitHub integration — a distinct GitHub account it alone cares about,
independent of whatever the account connected. There is no technical reason to
forbid it. A different GitHub account is a different `installation_id`, hence a
different connection; the UNIQUE keystone is untouched. The single-org
`saas-integrations` already supported exactly this shape (one org, one connection,
one GitHub account). IT7 simply *preserves* it for a workspace instead of erasing
it under resolution.

**Mechanism.** Add `connections.scope ∈ {account, workspace}` (default `account`,
so every existing row is back-compatible). Ownership and resolution become
scope-aware (§2):

- `scope = 'account'` → owned at `effectiveIntegrationOrg(org)`; shared; resolves
  up. (Standalone orgs are this scope and collapse to themselves — no change.)
- `scope = 'workspace'` → owned at `connection.orgId` (the workspace); **never**
  resolved up; invisible to siblings and to the account.

**Where scope is decided — the surface, not a flag the user toggles.** Connecting
from the **account** Integrations page creates an `account`-scoped connection;
connecting from a **workspace** Integrations page creates a `workspace`-scoped one.
The signed connect state (`payload.o` = the initiating org) already carries enough
to set scope at setup time; IT7 records it on the row.

**Keystone collision is a helpful redirect, not a dead end.** If a workspace tries
to connect a GitHub account the account already holds as shared, the
`installation_id` UNIQUE refuses — but the console must read the existing
connection's scope and say *"This GitHub account is already connected at the
account level; link its repos from your Git tab"* rather than the bare "Already
connected". The reverse (an account trying to absorb an account already held
privately by a workspace) surfaces the symmetric message. No installation ever
flips scope silently — changing scope is an explicit, audited operation (out of
scope for IT7; record as D5 if demanded).

**Why this is low-risk.** A private connection re-uses the *exact* pre-tenancy code
paths (owner org = the connection's org); it adds no projection, no fan-out, no
cross-org resolution. The only new surface is the workspace-level connect entry
point and the scope column. It is, deliberately, the smallest possible departure.

## 11. Admission control & share mode (IT8)

Sharing in the original draft was implicit and total: being a child of the account
meant automatic, ungoverned access to the account's connection, gated only by
repo-link ownership. That is the right *default* (least friction, mirrors pooled
billing) but the wrong *only option* — an account with semi-independent teams needs
to say "this connection is for workspaces A and C, not everyone." IT8 makes sharing
**governed without making it RBAC**.

**Share mode** — a column on the connection:

- `auto` (**default**) — every workspace under the account is implicitly admitted.
  This is exactly today's soft behavior; existing connections need no migration.
- `granted` — a workspace may consume the connection only if it holds an active
  **admission grant**.

**Admission grants** — `integrations.connection_grants (connection_id, org_id,
granted_by, granted_at, status)`, one row per admitted workspace. Under `auto` the
table is unused (admission is implicit); under `granted` it is the gate. Membership
in the account is still required — a grant can only name a workspace that is a child
of the connection's owning account (enforced at write, asserted by the split-brain
suite).

**Two stacked gates, both fail-closed.** A workspace consuming a shared connection
must pass, in order:

1. **Admission** — `share_mode = 'auto'` OR an active grant exists. (New, §11.)
2. **Repo-link ownership** — the workspace owns an active `repo_link` for the repo
   under that connection. (Existing, §4/§6.)

Both are checked at the three live touchpoints — **repo-link create** (you cannot
claim a repo on a connection you are not admitted to), the **token broker** (§6),
and **inbound projection** (§5; an event for a repo whose owning workspace lost
admission is treated as unlinked → account-scoped or skipped, never leaked). This is
defense in depth: admission is enforced at claim time, so the broker/projection
checks are belt-and-suspenders, but they keep the system correct across a
mid-flight grant revocation.

**Relationship to D1 (soft/hard sibling isolation).** Admission and visibility are
**orthogonal axes**, and keeping them separate is the point:

- *Admission* (§11) = **who may consume** the connection. `auto` vs `granted`.
- *Visibility* (D1) = **what an admitted workspace sees** of its siblings' links.
  Soft (default) = sees its own links + account connection status; hard = siblings'
  links invisible.

The common postures compose cleanly: `auto` + soft = today's frictionless default;
`granted` + soft = curated access, shared visibility within the admitted set;
`granted` + hard = the strictest "need-to-know" posture for regulated accounts.
Build the stricter combinations on explicit demand (D1, D5) — the schema supports
all four from day one because the two columns are independent.

**Authorization stays exact-match (A4).** A grant is a row in an allow-list read at
resolution time, *not* a role in the parent and *not* a hierarchical-RBAC edge. The
workspace member is still authorized against their own workspace membership; the
grant only decides whether the resolution seam will hand them the account's
connection. This is the same trust shape as the seam itself.
