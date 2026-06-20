# orun-cloud

**A production SaaS platform written as a portable collection of component
intent — compiled and converged by [Orun](https://orun.sourceplane.ai).**

orun-cloud is a reusable Cloudflare + Supabase multi-tenant SaaS starter, and a
real-world proof of the Orun model. Every Worker, Terraform stack, and database
migration declares itself as **component intent** next to its code; the repo as
a whole is **platform intent**; and CI never runs a raw `pnpm`, `wrangler`, or
`terraform` command — it runs `orun plan` and `orun run`, compiling the platform
into a deterministic state and converging the deviation on every commit.

Identity, organizations, projects, RBAC, audit, metering, billing, webhooks, and
notifications ship as separate bounded-context Cloudflare Workers behind a single
public edge API, with a Next.js console on Workers + Static Assets.

> **The thesis, made concrete.** Orun treats your whole platform as intent:
> platform intent (`intent.yaml`), component intent (`component.yaml` beside each
> unit), and golden-path intent (the repo-local **Stack Tectonic** composition
> stack). orun-cloud is what that looks like at production scale — fork it, grow
> it a few components at a time, and every commit reconverges toward the desired
> state you declared. See **[Orun](https://orun.sourceplane.ai)** for the model.

## Status

- **Runtime is live, per environment, through Orun.** The edge API, the
  bounded-context Workers, and the console deploy to `stage` and `prod` via
  `orun run` (no direct Wrangler/Terraform/pnpm in CI).
- **Data plane is provisioned by Terraform:** Supabase `stage` and `prod`
  projects, Cloudflare Hyperdrive (pooled Postgres for Workers), and the
  `api-edge` idempotency KV namespace, with credentials in AWS Secrets Manager.
- **Database migrations** run through the `db-migrate` component (plan on PRs,
  apply on merge to `main`).
- **Billing** is live end-to-end via the Polar adapter (embedded checkout,
  plan changes, multi-org fan-out).
- **Known credential-blocked tails** (see `specs/epics/saas-baseline/`): full
  production OAuth/magic-link auth and Stripe require human-supplied
  credentials. The notifications email provider is Cloudflare Email Service
  (`cloudflare-email`, no API key — the `send_email` binding is the
  credential); it needs one-time account setup: Workers Paid plan and the
  sending domain verified in Email Service (DKIM/SPF).
- The `dev` environment is verify-only (no provisioned Supabase project by
  design).

## Forking / rebranding

This baseline is built to be instantiated as new products. The mechanical
rename (repo slug, product name/domain, SDK class, CLI bin, worker prefixes,
user agents, workers.dev subdomain) is one script —
`node tooling/rebrand/rebrand.mjs --values my-brand.json` — and everything
that needs human hands is a checklist. Forks can also grow **a few
components at a time**: `tooling/fork/components.mjs` orders and validates
per-component copies against the full prerequisite graph (and keeps
`pnpm-lock.yaml` in sync). See **[FORKING.md](FORKING.md)**.

## Prerequisites

- Node.js >= 20 (CI and components run on Node 22)
- pnpm >= 10 (`npm install -g pnpm`)
- (Optional, for local Orun validation) the `kiox` CLI on your `PATH`. `kiox`
  pins the Orun provider declared in `kiox.yaml`; invoke Orun as
  `kiox -- orun ...`.

## Getting Started

```bash
# Install all workspace dependencies
pnpm install

# Type-check / lint / test / build across the workspace (Turborepo)
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Workspace Layout

```
apps/api-edge             Public HTTP entry point (Cloudflare Worker)
apps/identity-worker      Users, sessions, API keys, OAuth
apps/membership-worker    Organizations, members, invitations, role assignments
apps/projects-worker      Projects and environments
apps/policy-worker        Deny-by-default RBAC evaluation
apps/events-worker        Domain events, audit log, observability
apps/config-worker        Settings, feature flags, secret metadata
apps/metering-worker      Usage ingestion, quotas, rollups
apps/billing-worker       Plans, subscriptions, invoices (Polar adapter)
apps/notifications-worker Email delivery and preferences
apps/webhooks-worker      Outgoing webhooks: signing, delivery, replay
apps/admin-worker         Audited admin/support workflows
apps/web-console-next     Next.js console (Cloudflare Workers + Static Assets)

packages/contracts        Shared API, tenancy, event, and error types + validators
packages/policy-engine    RBAC evaluation logic
packages/db               Migration harness, manifest, and runner
packages/sdk              TypeScript SDK (contract-driven)
packages/cli              `orun-cloud` CLI
packages/notifications-client  Notifications client
packages/shared           Generic helpers (IDs, errors) — no domain logic
packages/testing          Test fixtures and utilities

infra/terraform/bootstrap          Verifies AWS state backend + Secrets access
infra/terraform/supabase           Supabase project provisioning (stage/prod)
infra/terraform/cloudflare-hyperdrive  Hyperdrive config fronting Supabase
infra/terraform/cloudflare-kv      api-edge idempotency KV namespace
infra/terraform/cloudflare-domain  Zone adoption + console custom domain
infra/db-migrate                   Database migration runner component

stack-tectonic            Repo-local Orun composition stack (execution contracts)
tooling/tsconfig          Shared TypeScript configurations
tooling/eslint            Shared ESLint configuration
tests/*                   Per-component contract and verifier test suites
```

## CI

CI is powered by [Orun](https://orun.sourceplane.ai) with the local Stack
Tectonic composition stack — the repo's **golden-path intent**. Each commit,
Orun compiles the platform intent and converges only the deviation:
`.github/workflows/ci.yml` calls only `orun plan` and `orun run` — no direct
`pnpm`, `turbo`, Wrangler, or Terraform commands run in GitHub Actions. The Orun runtime is pinned in `kiox.yaml` (resolved digest in
`kiox.lock`); the workflow's `orun-action` `version:` matches that pin.

### Local Orun Verification

```bash
kiox -- orun compositions lock --intent intent.yaml
kiox -- orun validate --intent intent.yaml
kiox -- orun plan --changed --intent intent.yaml --output plan.json
kiox -- orun run --plan plan.json --dry-run --runner github-actions
```

Use `--changed` for PR-scoped checks; use a full plan when validating
environment promotion or cross-component dependencies (`--view dag`).

## Infrastructure

Terraform provisions Supabase projects, Cloudflare Hyperdrive, and the
`api-edge` KV namespace for `stage` and `prod`. Credentials are generated by
Terraform and stored in AWS Secrets Manager under
`<org>/orun-cloud/<component>/<env>`. Terraform state uses the shared S3
buckets `sourceplane-<env>` (IAM roles and buckets are owned by the `aws-admin`
repo). See `specs/core/access-and-infra.md` for the access model and the
manual prerequisites.

## Adding a New Component

Each component is a self-contained unit of intent — declare it next to its code
and Orun binds it to the platform on the next plan. No global script to edit.

1. Create the directory under `apps/`, `packages/`, `tests/`, or `infra/`.
2. Add a `component.yaml` with the appropriate `spec.type` — one of
   `cloudflare-worker-turbo`, `cloudflare-workers-assets-turbo`, `terraform`,
   `db-migrate`, or `turbo-package` — plus `subscribe.environments` and the
   typed `parameters` the composition schema requires.
3. Orun discovers it automatically on the next plan (`discovery.roots` covers
   `apps/`, `infra/`, `packages/`, `tests/`). Validate with
   `kiox -- orun validate --intent intent.yaml`.

See `specs/core/orun-golden-path.md` for the intent/component/composition layer
rules before changing CI, infra, or `intent.yaml`.
