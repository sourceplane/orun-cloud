# saas-workspaces — Design

Status: Draft (normative once WS1 lands)

The vocabulary and the aliasing strategy for presenting the parent/child org
model as an **Account** that contains **Workspaces**, without touching the data
model. Written against repo reality as of 2026-06-29 (`saas-multi-org-billing`
MO1+ shipped; the console already has `useEffectiveOrgSlug` + a scope-switcher;
`apps/api-edge/src/org-facade.ts` serves `/v1/organizations/*`).

## 1. Glossary (WS1)

| Public term | Internal reality | Notes |
|-------------|------------------|-------|
| **Account** | the **tenant**: a standalone org, or a parent org (`parent_org_id IS NULL`) that owns billing | One billing customer, one GitHub connection (`saas-integration-tenancy`), one usage roll-up. |
| **Workspace** | **any `organizations` row in the account** — a child org, **and** the parent's own direct org surfaced as a Workspace | A Workspace *is* an org; it keeps its own `org_id`, projects, environments, members, audit. |
| Project | unchanged (`project_id` under an org/Workspace) | Not renamed. The `Workspace → Project → Environment` hierarchy reads cleanly. |

One internal-name collision to keep in view: the state subsystem already ships a
table named **`state.workspace_links`** (the CLI/CI repo allow-list, keyed
`(org, project)`), which predates this rebrand and has nothing to do with the new
"Workspace" noun. After the rename "workspace links" is ambiguous between (a) that
state table, (b) a Workspace's `integrations.repo_links`
(`saas-integration-tenancy`), and (c) the public `…/cli/links` endpoint. The
glossary (WS1) must record that `workspace_links` is a **legacy internal name**,
left as-is per the relabel-not-remodel rule (§2), and is **not** the Workspace
unit. Do not rename the table; do disambiguate it in docs.

Two names we explicitly reject:

- **"Product"** — already means the **Polar product** (the billing SKU) across
  `apps/billing-worker/src/billing-provider/*`, `plan-catalog.ts`, and the
  multi-org-billing catalog. Reusing it would collide in code and docs.
- Reusing **"Project"** for the unit — `project` is the existing sub-org work unit;
  `Workspace → Project` must stay two distinct, non-homophone levels.

## 2. The rule: relabel, do not remodel

This epic introduces **no new entity**. There is no `workspaces` table, no
`products` table. A Workspace is a row in `membership.organizations`; an Account
is the org at `effectiveBillingOrg`/`effectiveIntegrationOrg`. Untouched:

- `membership.organizations`, `parent_org_id`, and `org_id` on every table in
  every schema.
- Internal service routes, policy scope (`scope.orgId`), actor `orgId` binding,
  audit envelopes, billing resolution.

Renaming at the model layer would be a platform-wide migration fighting
`org_id`-everywhere for zero functional gain. The cost/benefit only works as a
**public vocabulary layer**.

## 3. Public API aliasing (WS2) — the chosen depth

Three depths were considered; we take the **middle** one:

| Depth | What it means | Verdict |
|-------|---------------|---------|
| Label-only | Console says "Workspace"; API/URLs/SDK still say `organization` | Rejected — brand/impl mismatch confuses anyone reading API docs next to the dashboard. |
| **Label + public API aliasing** | Add `/v1/workspaces/*` aliases + `workspaceId` response fields; internal model unchanged | **Chosen** — consistent public surface, bounded cost, fully back-compatible. |
| Full model rename | Rename tables/columns/scopes to `workspace` | Rejected — enormous, risky, no functional gain. |

Mechanics:

- **Routes.** `/v1/workspaces/{workspaceId}/…` aliases
  `/v1/organizations/{orgId}/…` at `apps/api-edge`. The alias is a thin
  path-rewrite into the **same** facade/handlers (`org-facade.ts`); `workspaceId`
  is the same opaque org public id (`org_*`). No handler is forked.
- **Contracts.** Response shapes gain a `workspaceId` field **alongside** the
  existing `orgId` (same value), and request bodies accept either. `orgId` is
  retained and documented as the durable id; `workspaceId` is the alias. (Or a
  single id with both field names projected — decided in `packages/contracts`.)
- **Account routes.** `/v1/accounts/{accountId}/…` optionally aliases the
  parent-scoped reads (billing summary, usage roll-up) that already resolve to
  `effectiveBillingOrg` — surfacing the "Account" term where the parent is the
  subject. Lower priority than the Workspace alias.
- **Internal stays `org`.** Service-to-service calls, DB, policy, and audit keep
  `org`/`org_id`. The alias is a public-surface projection only.

## 4. The parent as both Account and Workspace (WS4)

`saas-multi-org-billing` §8: an org *becomes* a parent on its first child with no
row rewrite, and the parent keeps its own projects/environments. So the parent is
already "an org that contains other orgs **and** holds work directly." We surface
that as:

- The parent appears as the **Account** (the header/scope the billing and GitHub
  connection live on), **and**
- as one selectable **Workspace** in the switcher (its own direct org), so an
  operator can work in the parent's workspace exactly like any child's.

This is a **synthetic UI affordance** over the existing org list + scope-switcher
(`use-effective-org.ts`); it needs no schema change and no "default child" row.

## 5. Console rebrand (WS4)

- The scope-switcher becomes the **Workspace switcher**, grouped under the
  **Account**; copy, empty states, and Cmd-K actions ("Switch workspace", "Create
  workspace") adopt the vocabulary, reusing the existing chrome and `saas-console-ux`
  conventions.
- "Create organization" → "Create workspace" (still gated by `feature.multi_org`
  + `limit.organizations`, unchanged — MO2 UX reused verbatim).
- Account-level surfaces (billing, the shared GitHub connection, usage Overall-vs-
  Individual) render on the Account; per-Workspace surfaces (projects, members)
  render on the selected Workspace.

## 6. SDK / CLI (WS3)

There are **two** CLIs, and they sit at very different distances from the
customer — the rename has to name both:

- **`@saas/cli` (`orun-cloud`, TS, `packages/cli`)** — the internal control-plane
  CLI that wraps `@saas/sdk`. It gains a `workspace` namespace aliasing
  `organizations`, exactly as the SDK does.
- **`orun` (Go, `sourceplane/orun`)** — the **customer-facing** CLI that runs in
  CI and on dev machines. It is the primary surface where the `org` vocabulary is
  visible today: the `--org` flag, the `ORUN_ORG` env var, and — since
  `oidc-ci-tenancy` shipped (orun #420) — the **committed `intent.yaml` field
  `execution.state.org`** (with `requireOrg`). `execution.state.org` is the
  declared, reviewable tenancy *claim* sent on every remote op. This CLI is owned
  by `saas-orun-platform` (DV5), so WS3 here is a *coordination* item, not a
  unilateral one: the rename must be planned with that epic, not landed only in
  `packages/cli`.

CLI surface plan:

- **SDK** exposes a `workspaces` namespace that aliases `organizations` (same
  client, same ids); `organizations` is retained and marked deprecated-in-favor-of
  in docs, not removed.
- **CLIs** gain a `workspace`/`--workspace` alias for `org`/`--org`
  (and `ORUN_WORKSPACE` aliasing `ORUN_ORG`). Help text leads with Workspace.
- **`intent.yaml`** is the one committed, customer-authored surface, so it needs
  an explicit decision (see risks **D5**): either alias
  `execution.state.workspace` to `execution.state.org` (read either, prefer the
  newer), or hold `execution.state.org` as the durable spelling and document
  "this org *is* your Workspace." Either way the **value** a customer declares is
  their **Workspace** org — never the Account; the integration connection that
  resolves *up* to the Account (`saas-integration-tenancy`) is a server-side
  resolution the CLI claim never restates.

## 7. Back-compat & deprecation (WS5)

- **Nothing is removed.** `/v1/organizations/*`, the `orgId` field, and the
  `organizations` SDK namespace all keep working indefinitely within the
  deprecation window; the Workspace surface is purely additive.
- **Deprecation policy** (decided in risks): how long both terms coexist publicly,
  and whether audit-event names / analytics keep `org.*` (internal) or also emit
  `workspace.*` aliases. Default lean: keep audit/event names `org.*` internally
  (stable contract), document the Account/Workspace mapping, and do **not** fork
  the event taxonomy.

## 8. What deliberately does NOT change

- No new entity, no table rename, no `org_id` rename — a Workspace is an org.
- No billing behavior — `effectiveBillingOrg`, fan-out, gates, the plan catalog
  are untouched; only labels and aliases change.
- No integration mechanism — that is `saas-integration-tenancy`; this epic only
  supplies the words it speaks.
- No renaming of `project`/`environment`.
