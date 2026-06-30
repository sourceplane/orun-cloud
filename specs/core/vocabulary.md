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

## Back-compat & deprecation policy (published — WS5)

Nothing is removed. `/v1/organizations/*`, the `orgId` field, the SDK
`organizations` namespace, and `--org`/`execution.state.org` all keep working
**indefinitely** — there is no removal date (decision D4). The Workspace surface
is purely additive.

- **Legacy surface coexistence:** indefinite; removing it is a breaking change
  that requires a separate, announced migration with customer notice.
- **Event/audit taxonomy:** stays `org.*` internally and on the wire (decision
  D3) — event names are a stable contract and are **not** forked to `workspace.*`.
- The normative statement of this policy lives in
  [`contracts/api-guidelines.md`](./contracts/api-guidelines.md) (§ Public
  vocabulary / § Deprecation & coexistence policy).

## Workspace ID — the durable public handle (WID1)

Status: Normative (the public identifier format; see `epics/saas-workspace-id`).

The **Workspace ID** is the short, immutable, public handle for a Workspace — the
id a human quotes to support, pastes into the CLI, and commits into `intent.yaml`.
It is the AWS-account-id analog the platform previously lacked: `org_<hex>` is
stable but a 36-char hex blob, and the `slug` is friendly but **mutable** (so it is
unsafe as a durable reference). The Workspace ID is the third, distinct identifier.

### The three identifiers (do not conflate)

| Identifier | Role | Mutable? | Where it appears |
|------------|------|----------|------------------|
| **Workspace ID** `ws_…` | durable public handle | **no** | API paths + bodies (led), SDK/CLI, tokens, console "copy id", `intent.yaml` |
| **`slug`** | vanity / URL label | yes | console URL (`/orgs/{slug}/…`), sign-in |
| **`org_<hex>` / UUID** | internal primary key + legacy public id | no | DB columns, internal service-to-service, legacy `/v1/organizations/*`, `org.*` audit, in-flight tokens |

An optional **`acct_…`** Account handle may later surface the Account (parent) with
the same value as the parent's `ws_…` until the Account becomes a first-class entity
(`saas-workspace-id` Stage 2); it is not minted at WID1.

### Format

- **`ws_`** prefix + **Crockford base32** body (uppercase `A–Z`/`2–9`, excluding
  `I L O U`), e.g. `ws_3KF9TQ2P`. Prefixed — *not* a bare AWS-style number — to keep
  the platform's `usr_`/`prj_`/`org_` convention and to preserve id-kind
  discrimination (audit envelopes, webhook payloads, `parseSubjectUuid`).
- **Immutable.** Generated once at creation (the `create-organization` transaction),
  stored in a dedicated `membership.organizations.public_ref` column — never a
  re-encoded UUID and never the mutable slug. Safe to commit and to quote forever.

### Rules

- **`org_<hex>` is retained indefinitely** as an accepted/returned alias (extends WS
  decision D4). `ws_…` is led-with on public surfaces; `org_<hex>`,
  `/v1/organizations/*`, the UUID PKs, and the `org.*` taxonomy are never removed.
- **Role is never encoded in the id.** Account-vs-Workspace is *mutable, relational*
  state (an org becomes an Account on its first child, and the parent is *both*).
  Discover it via the `accountId` field (`= effectiveBillingOrgId(org) =
  parentOrgId ?? id`) and the derived `kind`/`isAccountRoot`; the invariant is
  **`accountId === workspaceId` ⟺ Account root**. Never branch security or routing
  logic on a parsed id prefix — authority comes from the resolved record.
- The normative id/account-layer design lives in
  [`../epics/saas-workspace-id/design.md`](../epics/saas-workspace-id/design.md).
