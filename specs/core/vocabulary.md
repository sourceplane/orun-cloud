# Public Vocabulary: Account & Workspace

Status: Normative (the public-surface names; the data model is unchanged)

This is the canonical glossary for the **Account / Workspace** vocabulary that the
console, public API, SDK, and CLIs speak. It is the WS1 deliverable of
`specs/epics/saas-workspaces` and the single source of truth for the rename.

The rule is **relabel, not remodel**: there is *no* new entity. A Workspace **is**
an `membership.organizations` row; an Account is the org at
`effectiveBillingOrg`/`effectiveIntegrationOrg`. `org_id`-everywhere — schemas,
internal routes, policy scope, audit envelopes — is untouched. The new names live
only at the public surface (edge route aliases, contract projections, console
copy, SDK/CLI vocabulary).

## Glossary

| Public term | Internal reality | Notes |
|-------------|------------------|-------|
| **Account** | the **tenant**: a standalone org, or a parent org (`parent_org_id IS NULL`) that owns billing | One billing customer, one GitHub connection (`saas-integration-tenancy`), one usage roll-up. |
| **Workspace** | **any `membership.organizations` row in the Account** — a child org, **and** the parent's own direct org surfaced as a Workspace | A Workspace *is* an org; it keeps its own `org_id`, projects, environments, members, audit. The public id alias is `workspaceId` (same opaque `org_*` value as `orgId`). |
| **Project** | unchanged (`project_id` under an org/Workspace) | Not renamed. The hierarchy reads `Account → Workspace → Project → Environment`. |
| **Environment** | unchanged (`environment_id` under a project) | Not renamed. |

## Names we explicitly reject

- **"Product"** — already means the **Polar product** (the billing SKU) across
  `apps/billing-worker/src/billing-provider/*`, `plan-catalog.ts`, and the
  multi-org-billing catalog. Reusing it would collide in code and docs.
- Reusing **"Project"** for the unit — `project` is the existing sub-org work unit;
  `Workspace → Project` must stay two distinct, non-homophone levels.

## Legacy internal names that collide (do NOT rename)

Two pre-existing internal names use the word "workspace" and have **nothing** to do
with the Workspace unit. Per relabel-not-remodel they are left exactly as-is; docs
disambiguate them:

| Legacy internal name | What it actually is | Not to be confused with |
|----------------------|---------------------|-------------------------|
| `state.workspace_links` | the **CLI / CI repo allow-list** in the state subsystem, keyed `(org, project = repo)`; consumed by the Orun CLI via `…/cli/links` | the Workspace unit; and `integrations.repo_links` (the GitHub-connection repo claims in `saas-integration-tenancy`) |
| `Project` described as an "operational workspace" in older `domain-model.md` prose | a **Project**, the sub-org work unit | the Workspace unit |

## Where the value points (cross-epic invariant)

- The Orun CLI's committed tenancy claim (`intent.yaml execution.state.workspace`,
  aliasing the shipped `execution.state.org`; `--workspace`/`--org`,
  `ORUN_WORKSPACE`/`ORUN_ORG`) is always a **Workspace** org — **never** the
  Account.
- Only the GitHub **connection** resolves *up* to the Account
  (`effectiveIntegrationOrg`, `saas-integration-tenancy`). That is a server-side
  resolution; the CLI claim and `state.workspace_links` stay workspace-local.

## Back-compat

Nothing is removed. `/v1/organizations/*`, the `orgId` field, the SDK
`organizations` namespace, and `--org`/`execution.state.org` all keep working
indefinitely within the deprecation window (`saas-workspaces` WS5 / risk D4). The
Workspace surface is purely additive.
