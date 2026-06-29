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

## 9. What deliberately does NOT change

- No second GitHub App, no second installation, no relaxed `installation_id`
  uniqueness — the keystone is sacred.
- No fan-out (copying) of connections or tokens — credentials resolve up only.
- No change to `check-entitlement` — `feature.integrations.github` already fans
  down per MO3.
- No change to the scoped-token mint path — only *which connection* it resolves
  and *how access is authorized*.
- No hierarchical RBAC — authorization stays exact-match; only resource
  *addressing* resolves to the account.
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
