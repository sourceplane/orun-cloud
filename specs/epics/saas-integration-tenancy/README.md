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

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — not started; depends on `saas-integrations` IG1+ live paths and the shipped `saas-multi-org-billing` MO1 parent/child seam |
| Cluster | **IT** (integration tenancy — bridges **IG** `saas-integrations` and **MO** `saas-multi-org-billing`) |
| Owner(s) | `apps/integrations-worker` + `packages/db` + `apps/api-edge` + `apps/web-console-next` (+ `packages/contracts`/`sdk`) |
| Target branch | `main` (PRs merged incrementally) |
| Builds on | `saas-integrations/design.md` §4 (tenancy keystone) + §6 (inbound pipeline) + §7 (token broker); `saas-multi-org-billing/design.md` §4 (`effectiveBillingOrg` resolution seam) + §5 (fan-out); `packages/db/.../180_integrations_foundation`; `packages/db/src/membership/billing-scope.ts` |
| Decisions locked | Structural: (1) the **integration tenant boundary is the parent (account) org**, resolved by a new `effectiveIntegrationOrg(org) = parentOrgId ?? org.id` seam (twin of `effectiveBillingOrg`); (2) the **credential is resolved UP, never fanned out** — you cannot copy a live installation, so the connection is owned at the parent and read through the seam (entitlements still fan **down** unchanged); (3) the `installation_id` UNIQUE → one-connection keystone is **preserved** — no constraint is relaxed; (4) sibling isolation defaults to **soft** — workspaces share the account's connection and what each sees is scoped by project/policy, mirroring how children already share a billing customer. |
| Gate | IT1 (the dormant resolution seam) is human-independent and back-compatible. IT2+ live paths need `saas-integrations` IG1/IG2/IG4 landed (connect, inbound, broker) and a registered GitHub App per env. The one product decision — **soft vs hard sibling isolation** — is registered in `risks-and-open-questions.md` (default: soft). |

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

1. `README.md` (this file) — status + thesis + milestones-at-a-glance.
2. `design.md` — the resolution seam, what resolves up vs down, repo single-claim,
   webhook projection, the token broker change, authorization, lifecycle.
3. `implementation-plan.md` — IT1–IT6, each with "done when".
4. `risks-and-open-questions.md` — soft-vs-hard sibling isolation, detach
   behavior, the split-brain-tenancy guard.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| IT1 | Resolution seam (dormant): `effectiveIntegrationOrg` + route connection reads through it — collapses to `org.id` for standalone orgs, **no behavior change** | 🗓️ Planned |
| IT2 | Repo single-claim: a repo under a shared connection is claimable by one workspace/project; workspace links repos against the account's connection | 🗓️ Planned |
| IT3 | Inbound projection: `drain.ts` attributes `installation → account connection → owning workspace org`, exactly-once per workspace | 🗓️ Planned |
| IT4 | Token broker at the account: resolve the connection via `effectiveIntegrationOrg`, authorize by workspace repo-link ownership, scope token per repo (unchanged scope-down) | 🗓️ Planned |
| IT5 | Console: connection lives on the **account**; each workspace's Git tab links repos against it; sibling visibility scoping (soft default) | 🗓️ Planned |
| IT6 | Lifecycle: detach (`clear parent_org_id`) repo-link rule, parent-side uninstall cascade, audit + the split-brain invariant test suite | 🗓️ Planned |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The `effectiveIntegrationOrg` resolution seam; connection ownership at the account; repo single-claim; webhook projection to workspaces; the token-broker resolution + authorization change; the console surfaces; the detach/uninstall lifecycle rules; the split-brain guard | The base connect/inbound/broker mechanics (owned by `saas-integrations` IG1/IG2/IG4 — consumed as-is); the parent/child org primitive + entitlement fan-out (owned by `saas-multi-org-billing` — consumed as-is); the **Workspace** rebrand of the noun (→ `saas-workspaces`); hard cross-workspace RBAC (a `components/04` follow-up); pooled quotas |

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
