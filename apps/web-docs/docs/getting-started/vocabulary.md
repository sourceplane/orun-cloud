---
title: Vocabulary
description: The Orun Cloud tenancy model — accounts, workspaces, projects, environments — plus actors and identifier prefixes.
---

Orun Cloud's tenancy model is a four-level hierarchy: **Account → Workspace → Project → Environment**. This page defines each term, the actors that operate on them, and the identifier formats you'll see in IDs, tokens, and API responses.

## Account

An **Account** is the tenant: the top-level unit that owns billing, the GitHub connection, and the usage roll-up. Internally it is a parent organization — a standalone workspace is its own account, and a workspace with children resolves billing and integrations up to its parent.

Account-scoped roles — `account_owner`, `account_admin`, `account_billing_admin` — are granted on the account and **cascade** to authority on every workspace under it, without per-workspace grants. See [RBAC](/platform/access-control/rbac).

Whether an org is an account root is *relational* state, not something encoded in its id: the invariant is `accountId === workspaceId` exactly when the workspace is the account root. Never branch logic on a parsed id prefix — authority comes from the resolved record.

## Workspace

A **Workspace** is where day-to-day work lives: projects, environments, members, audit. It is the unit you select in the console (`app.orun.dev/orgs/{slug}/…`), pass to the CLI, and commit into `intent.yaml`.

:::note Workspace == organization
The API's canonical name for a workspace is **organization** — a workspace *is* an organization row; there is no separate entity. Canonical paths read `/v1/organizations/{orgId}`, and `/v1/workspaces/*` is an accepted alias that rewrites to the same handlers. On the alias surface, responses carry a `workspaceId` field alongside every `orgId` (same opaque `org_…` value), and request bodies accept either spelling. The legacy surface — `/v1/organizations/*`, the `orgId` field, `--org` — keeps working indefinitely; the Workspace vocabulary is purely additive.
:::

A workspace has three identifiers. Do not conflate them:

| Identifier | Role | Mutable? | Where it appears |
| --- | --- | --- | --- |
| **Workspace ID** `ws_…` | Durable public handle | No | API paths and bodies, SDK/CLI, console "copy ID", `intent.yaml` |
| **Slug** | Vanity / URL label | Yes | Console URLs (`/orgs/{slug}/…`) |
| **`org_<hex>`** | Internal primary key and legacy public id | No | API responses (`orgId`), `/v1/organizations/*` paths, audit events |

The Workspace ID is `ws_` plus a Crockford base32 body (e.g. `ws_3KF9TQ2P`), generated once at creation and never changed — safe to commit and quote forever. The slug is friendly but mutable, so it is unsafe as a stored reference. Where the API takes a workspace reference in a path, the edge resolves all three forms — `ws_…`, slug, or `org_<hex>`.

## Project

A **Project** is the operational boundary where product work happens — in the current vocabulary a project maps one-to-one to a **repo**. Projects hold environments, configuration, remote state, runs, and git links. Id prefix `prj_`. See [Projects and environments](/platform/projects/projects-and-environments).

## Environment

An **Environment** is an optional deployment/configuration boundary inside a project (for example `stage` and `prod`). Id prefix `env_`.

## Actors

Every API request acts as one of four actor kinds; audit events record which:

| Actor kind | What it is | Authenticates with |
| --- | --- | --- |
| `user` | A human, signed in via the console | Session token (`sps_ses_<id>.<secret>`) |
| `service_principal` | A machine identity created as a workspace [API key](/platform/identity/api-keys) | The API key secret as a Bearer token |
| `workflow` | A CI run (GitHub Actions) | OIDC exchange (`POST /v1/auth/oidc/exchange`), minting a token bound to (workspace, project) |
| `system` | The platform itself (internal jobs) | Internal only |

See [Authentication](/platform/identity/authentication) and [CLI and CI auth](/platform/identity/cli-and-ci-auth).

## Identifier prefixes

Public ids are prefixed so you can tell what kind of thing an id refers to at a glance:

| Prefix | Kind |
| --- | --- |
| `ws_` | Workspace ID (durable public handle; Crockford base32) |
| `org_` | Organization / workspace (legacy public id; 32-hex body) |
| `prj_` | Project |
| `env_` | Environment |
| `usr_` | User |
| `team_` | Team |
| `mem_` | Workspace member |
| `inv_` | Invitation |
| `ses_` | Session |
| `sps_ses_` | Session **token** (`sps_ses_<id>.<secret>` — id plus secret, not a bare id) |
| `chl_` | Sign-in challenge (email-code login) |
| `req_` | Request id (`meta.requestId` and the `x-request-id` header) |

Prefixes are a readability convention, not an authorization mechanism — servers resolve the record behind the id before trusting anything about it.

## Related

- [What is Orun Cloud?](/getting-started/what-is-orun-cloud)
- [Organizations](/platform/workspaces/organizations)
- [RBAC](/platform/access-control/rbac)
- [API overview](/api/overview)
