---
title: What is Orun Cloud?
description: The managed backend for orun and a production multi-tenant SaaS control plane — open, forkable, and deployed by orun itself.
---

**Orun Cloud** is the managed backend for [orun](https://orun.sourceplane.ai) — the intent compiler — and a production multi-tenant **SaaS control plane** in its own right. It gives orun users remote state, run history, and a catalog of what their platform contains; and it gives every product built on it the SaaS primitives that otherwise get rebuilt from scratch: identity, workspaces, RBAC, projects, configuration, audit, metering, billing, webhooks, notifications, and integrations.

It is also an **open, forkable baseline**: the whole platform is published at [github.com/sourceplane/orun-cloud](https://github.com/sourceplane/orun-cloud) and is built to be instantiated as new products.

## The managed backend for orun

orun compiles your platform's **intent** — `intent.yaml` plus a `component.yaml` beside each unit of code — into a deterministic plan and converges the deviation on every commit. Orun Cloud is where that workflow keeps its server-side state:

- **Remote state** — a state plane for orun's execution state, scoped to `(workspace, project)`, so plans and runs agree on reality across machines and CI.
- **Runs** — plan and run history per project, browsable in the console.
- **Catalog** — an inventory of the entities your platform intent declares, per workspace.

The `orun` CLI's cloud surface (`orun cloud link`, `orun cloud check`, `orun cloud open`, and `execution.state` in `intent.yaml`) is documented in the [orun docs](https://orun.sourceplane.ai/cli/orun-cloud); this site documents the Orun Cloud side — the API, the console, and the platform primitives.

## The SaaS control plane

Beyond the orun backend, Orun Cloud ships the full set of control-plane modules a multi-tenant product needs, each behind one public API:

| Area | What it covers |
| --- | --- |
| Identity | Users, sessions, API keys (service principals), CLI device auth, CI auth via OIDC |
| Workspaces | Organizations, members, invitations, teams, accounts (parent orgs) |
| Access control | Deny-by-default RBAC with workspace, project, and account roles |
| Projects | Projects (a project == a repo) and environments |
| Configuration | Settings, feature flags, secret metadata |
| Audit | Immutable audit log and security-event history |
| Metering | Usage ingestion, quotas, rollups |
| Billing | Plans, subscriptions, entitlements, checkout and portal |
| Webhooks | Signed outbound deliveries with retries and replay |
| Notifications | Email delivery and per-user preferences |
| Integrations | GitHub connection and repo-scoped tokens |

Everything is available three ways with the same contracts: the [console](/getting-started/console) at `https://app.orun.dev`, the [API](/api/overview) at `https://api.orun.dev`, and the [SDK](/developers/sdk) and [CLI](/developers/cli) for automation.

## An open, forkable baseline

The repo is a reusable Cloudflare + Supabase multi-tenant SaaS starter. Forks can rebrand mechanically (repo slug, product name and domain, SDK class, CLI bin, worker prefixes) with one script, and can grow a few components at a time — a tool orders and validates per-component copies against the full prerequisite graph. See [Deploy your own](/self-hosting/deploy-your-own).

## How it's built

Orun Cloud is a proof of the orun model at production scale — the platform declares itself as intent and is deployed by the tool it serves.

- **Bounded-context Cloudflare Workers behind one edge API.** Identity, membership, projects, policy, events, config, metering, billing, notifications, webhooks, and admin each run as a separate Worker. A single public entry point — `api-edge`, serving `https://api.orun.dev` — handles auth resolution, idempotency replay, rate limiting, and routing to the owning Worker over service bindings.
- **A Next.js console** on Cloudflare Workers + Static Assets at `https://app.orun.dev`, speaking the same public API through the SDK.
- **Supabase Postgres via Hyperdrive.** Supabase Postgres is the source of truth for domain state; Workers reach it through Cloudflare Hyperdrive (pooled Postgres) at repository-adapter boundaries. Terraform provisions the Supabase projects, Hyperdrive configs, and the idempotency KV namespace for `stage` and `prod`.
- **Deployed by orun itself.** Every Worker, Terraform stack, and database migration declares component intent next to its code; CI never runs a raw `pnpm`, `wrangler`, or `terraform` command — it runs `orun plan` and `orun run`, and every commit reconverges toward the declared state.

Shared contracts (`packages/contracts`) drive the API, the SDK, and the CLI, so all three surfaces stay in lockstep.

## What Orun Cloud is not

- **Not a CI system.** Orun Cloud does not run your pipelines and is not a replacement for GitHub Actions or other workflow engines. orun runs inside your CI; Orun Cloud is the backend it talks to.
- **Not an IaC tool.** Orun Cloud does not compile intent or converge infrastructure — that is orun. Orun Cloud stores the state, runs, and catalog that make orun useful across a team.
- **Not an orchestration platform.** It is not a generic Kubernetes or infrastructure orchestration layer, a user-authored policy DSL, or a marketplace platform.

In one line: **orun is the compiler; Orun Cloud is the backend.**

## Related

- [Quickstart](/getting-started/quickstart)
- [Vocabulary](/getting-started/vocabulary)
- [State plane overview](/platform/state-plane/overview)
- [Self-hosting architecture](/self-hosting/architecture)
