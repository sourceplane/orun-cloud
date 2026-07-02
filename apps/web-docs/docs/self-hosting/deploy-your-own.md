---
title: Run your own
description: Orun Cloud is an open, forkable baseline — everything is orun intent, CI only plans and converges, and a fork is a script plus an operator checklist.
---

Orun Cloud is not just a hosted product — the repository at
[github.com/sourceplane/orun-cloud](https://github.com/sourceplane/orun-cloud)
is a **forkable baseline**: a production multi-tenant SaaS you can rebrand and
deploy as your own product, converged by [orun](https://orun.sourceplane.ai),
the intent compiler this platform is the managed backend for.

## Everything is intent

The repo is a component-native desired-state repository, not a bag of CI
scripts:

- **Component intent** — every Worker, package, Terraform stack, and the
  migration runner declares itself in a `component.yaml` beside its code
  (name, `spec.type`, typed parameters, environment subscriptions,
  `dependsOn` edges).
- **Platform intent** — `intent.yaml` at the root declares environments
  (`dev`, `stage`, `prod`), discovery roots (`apps/`, `infra/`, `packages/`,
  `tests/`), triggers, and promotion policies.
- **Golden-path intent** — the repo-local **Stack Tectonic** composition stack
  (`stack-tectonic/`) defines the typed execution contracts (jobs, profiles,
  schemas) for each component type: `cloudflare-worker-turbo`,
  `cloudflare-workers-assets-turbo`, `terraform`, `db-migrate`,
  `turbo-package`.

orun compiles these three layers into an explicit plan DAG. For the model, see
the [orun docs](https://orun.sourceplane.ai).

## CI only plans and converges

`.github/workflows/ci.yml` calls **only `orun plan` and `orun run`** — no raw
`pnpm`, `turbo`, Wrangler, or Terraform commands run in GitHub Actions.

- **Pull requests** compile a changed-scope plan and verify: builds, tests,
  Terraform plans. `dev` is verify-only by design.
- **Merges to `main`** converge the deviation: `stage` and `prod` deploy lanes
  run behind `requireApproval: true`, and `prod` declares a promotion
  dependency on `stage` — production converges only after stage has.

The orun runtime is pinned in `kiox.yaml` (resolved digest in `kiox.lock`);
locally, invoke it through `kiox`:

```bash
kiox -- orun validate --intent intent.yaml
kiox -- orun plan --changed --intent intent.yaml --output plan.json
kiox -- orun run --plan plan.json --dry-run --runner github-actions
```

## Prerequisites

Per instance, you need accounts and credentials that no script can create for
you:

- **Cloudflare** — an account, a `workers.dev` subdomain, a zone for your
  product domain, and an API token with Workers, KV, Hyperdrive, and DNS
  scopes (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` as Actions secrets).
- **AWS** — GitHub-OIDC roles per environment (plan and production-deploy) and
  a Secrets Manager namespace for the repo. Terraform state lives in shared S3
  buckets; secrets in `<org>/<repo>/<component>/<env>` (see
  [Operations](/self-hosting/operations)).
- **Supabase** — organization access for a management token
  (`SUPABASE_API_KEY`). The per-environment projects themselves are created by
  the `supabase` Terraform component on first apply — no manual creation.
- **GitHub** — the repo, Actions, and (for the integrations cluster) per-env
  GitHub App registrations.

## Rebrand with one script

The mechanical rename — repo slug, product name and domain, SDK class, CLI
binary, worker prefixes, wire-visible user agents, `workers.dev` subdomain — is
one idempotent script driven by a values file:

```bash
node tooling/rebrand/rebrand.mjs --values my-brand.json --dry-run   # inspect
node tooling/rebrand/rebrand.mjs --values my-brand.json             # apply
node tooling/rebrand/rebrand.mjs --verify                           # sweep only
```

`my-brand.json` supplies `repoName`, `productName`, `productDomain`,
`brandSlug`, `cliBin`, `workersDevSubdomain`, and optionally `salesEmail`. The
script runs a leftover sweep that fails on any missed baseline identity and
writes a provenance record to `ai/context/fork-from-baseline.md`. It
deliberately does **not** touch org-owned identity (GitHub org, orun state
backend, shared S3 buckets, GitHub App slugs) — re-pointing those is an
infrastructure move, not a rebrand.

## Grow a fork a few components at a time

Instead of a full snapshot, a fork can start from the non-component skeleton
(`intent.yaml`, `kiox.yaml`, CI workflow, `stack-tectonic/`, `tooling/`,
workspace files — CI plans an empty matrix and is green) and copy components
in batches:

```bash
node tooling/fork/components.mjs --order        # numbered copy batches
node tooling/fork/components.mjs --copy policy-worker --from ../baseline-rebranded
node tooling/fork/components.mjs --check        # verify prerequisite closure
```

The tool builds the complete prerequisite graph — declared `dependsOn`,
wrangler service bindings, deploy-time wiring inputs, workspace package
dependencies, tests-follow-their-subject — and orders and validates every copy
against it. Facts it encodes: all `packages/*` ship as one foundation batch;
infra goes `bootstrap → supabase → cloudflare-hyperdrive → db-migrate` before
any DB-bound worker; and `billing-worker`, `membership-worker`,
`events-worker`, `notifications-worker` form a service-binding cycle that must
be copied and first deployed as one batch. Every batch resyncs
`pnpm-lock.yaml` — commit it; worker CI installs with `--frozen-lockfile`.

## The honest checklist: credential-blocked tails

Some surfaces need human-supplied credentials before they light up on a fork
(the repo specs under `specs/epics/saas-baseline/` track these):

- [ ] **OAuth / magic-link auth** — register GitHub and Google OAuth apps per
      environment, set the client IDs in the identity-worker template, and load
      the secrets with `wrangler secret put`.
- [ ] **Billing provider** — Polar products and env secrets (the live path);
      the Stripe adapter exists but stays credential-blocked until you supply
      keys.
- [ ] **Email domain** — notifications send via Cloudflare Email Service (the
      `send_email` binding is the credential): one-time Workers Paid plan and
      sending-domain verification (DKIM/SPF).
- [ ] **GitHub Apps** — per-environment registrations for the integrations
      cluster.

First-boot expectations: the `cloudflare-hyperdrive` Terraform plan is red on
PRs until the first `main` apply writes the Supabase credentials to Secrets
Manager (it converges after the first merge); always re-run the **full**
workflow rather than "re-run failed jobs"; and keep rollout PRs to a few
components so CI fan-out stays manageable.

## Add a new component

A component is a self-contained unit of intent — no global script to edit:

1. Create the directory under `apps/`, `packages/`, `tests/`, or `infra/`.
2. Add a `component.yaml` with the appropriate `spec.type`, plus
   `subscribe.environments` and the typed `parameters` the composition schema
   requires.
3. orun discovers it automatically on the next plan. Validate with
   `kiox -- orun validate --intent intent.yaml`.

## Related

- [Architecture](/self-hosting/architecture)
- [Operations](/self-hosting/operations)
- [What is Orun Cloud?](/getting-started/what-is-orun-cloud)
