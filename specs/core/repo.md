# Monorepo Spec

Status: Normative

## Intent

This repository starts as a Cloudflare-first monorepo for a reusable multi-tenant SaaS starter bootstrap. It should let implementation move quickly across identity, organizations, projects, membership, billing, audit, usage, notifications, webhooks, admin/support, and optional product extensions while preserving clean seams for later extraction into separate repos and deployments.

## Canonical Repo Shape

```text
intent.yaml                Orun intent — composition sources, discovery roots, env lanes
kiox.yaml                  Orun runtime pin, aligned with aws-admin
kiox.lock                  Resolved Kiox provider lock
/.orun                     Generated local Orun state, plans, locks, and runs; ignored by git
/.github
  /workflows
    ci.yml                 Portable Orun plan/run workflow for PRs and main

/stack-tectonic            Repo-owned operations catalog, aligned with aws-admin stack style
  stack.yaml
  /compositions

/apps
  /api-edge                Public HTTP entry Worker
    component.yaml         Component descriptor (type: cloudflare-worker-turbo)
  /web-console-next        Next.js console (Workers + Static Assets)
    component.yaml         Component descriptor (type: cloudflare-workers-assets-turbo)
  /identity-worker
    component.yaml
  /policy-worker
    component.yaml
  /membership-worker
    component.yaml
  /projects-worker
    component.yaml
  /notifications-worker
    component.yaml
  /webhooks-worker
    component.yaml
  /admin-worker
    component.yaml
  /resources-worker
    component.yaml         Optional starter extension for project-scoped resources
  /config-worker
    component.yaml
  /events-worker
    component.yaml
  /runtime-worker
    component.yaml         Optional starter extension for long-running resource workflows
  /metering-worker
    component.yaml
  /billing-worker
    component.yaml

/packages
  /contracts               Shared API, tenancy, event, starter, resource, and manifest types
    component.yaml         Component descriptor (type: turbo-package)
  /sdk                     Public TypeScript SDK
    component.yaml
  /cli                     Public CLI package
    component.yaml
  /ui                      Shared UI components and generated form helpers
    component.yaml
  /shared                  Generic helpers only: errors, logging, ids, tracing
    component.yaml
  /testing                 Test utilities, fixtures, contract assertions
    component.yaml

/tests
  /components
    /contracts-tests
      component.yaml       Test suite descriptor (type: turbo-test)
    /api-edge-tests
      component.yaml
    /identity-worker-tests
      component.yaml
    /web-console-next-tests
      component.yaml

/tooling
  /eslint
  /tsconfig
  /scripts

/infra
  /terraform
    /supabase              Supabase database/project and AWS Secrets Manager component
    /cloudflare            Worker, Hyperdrive, queue, and binding infrastructure
  /cloudflare              Wrangler configs, environments, bindings
  /ci                      CI templates and deployment notes

/specs
  ...this spec pack...
```

## Repo Rules

### Workspace and toolchain

- Use `pnpm` workspaces for package management.
- Use `turbo` or an equivalent task graph runner for build, test, typecheck, lint, and deploy pipelines inside components.
- Use `orun` as the only CI orchestration layer for validate, plan, test, verify, and deploy flows. Root scripts may wrap `kiox -- orun ...`, but CI gates must not bypass Orun with ad hoc shell steps.
- Use TypeScript across Workers, SDK, CLI, and shared packages for V1 velocity.
- Each deployable Worker keeps its own `wrangler.jsonc` and deployment pipeline.

### Deployment model

- The public entry point is `apps/api-edge`.
- Internal bounded contexts are separate Workers where service bindings add value.
- The web UI is a separate app and must talk to the public API, not internal Worker bindings.
- Starter-domain asynchronous work uses Cloudflare Queues and Workers behind the owning bounded context.
- Long-running product-resource orchestration may live in `apps/runtime-worker` using Cloudflare Workflows by default; Durable Objects may be used for locks and strongly consistent coordination.

### State ownership

- Each bounded context owns its own persistence.
- The primary relational store is Supabase Postgres, reached from Workers through Cloudflare Hyperdrive.
- In V1, a single Supabase project/database may host multiple bounded contexts, but each context must own a logical schema or table namespace, service credentials, and migrations that can be extracted without rewriting clients.
- No Worker may query another domain's tables or schemas directly.
- Shared caches in KV must be derived, disposable copies of source-of-truth data.
- Every project-scoped table, cache key, event, and query must carry `org_id + project_id`; never rely on `project_id` alone.

### Internal communication

- Prefer Cloudflare service bindings for internal Worker-to-Worker communication.
- Prefer RPC-style service bindings for internal command/query boundaries.
- HTTP fetch between Workers is allowed only when mirroring a public contract is intentional.
- Background work uses Cloudflare Queues and/or Workflows, never fire-and-forget calls without delivery tracking.

### Shared package rules

- `packages/contracts` may contain shared types, schema validators, and contract tests.
- `packages/shared` may contain only generic utilities with no domain knowledge.
- Domain logic must not live in `packages/shared`.
- UI packages must not import internal Worker code.

### Test component rules

- Every CI-gated test suite is modeled as a first-class Orun component under `tests/components/`.
- `packages/testing` holds shared fixtures, harnesses, and helpers; it is not the CI gate by itself.
- Deployable, package, and infra components must declare `dependsOn` edges to the test components that gate them.
- The starter test composition should begin as a repo-owned `turbo-test` contract inside `stack-tectonic/compositions/` so unit, contract, integration, and smoke suites can run through Orun with repo-specific inputs.
- A component that cannot name its required test component dependency is not ready to merge.

## Platform Resource Mapping

Use platform primitives deliberately:

- Workers: HTTP ingress and internal domain services
- Service bindings: internal synchronous calls
- Supabase Postgres: source-of-truth relational state for bounded contexts
- Hyperdrive: Worker-to-Postgres connectivity, pooling, and regional routing at the adapter layer
- D1: optional edge-local cache, test adapter, or managed customer resource; not the source of truth for starter domain state
- KV: read-heavy cache and idempotency records
- R2: artifacts, manifest bundles, export files, dead-letter archives
- Queues: asynchronous delivery and fanout steps
- Workflows: durable multistep orchestration
- Durable Objects: per-resource locking, coordination, and strongly consistent local state where needed
- Secrets Store and Worker secrets: platform credentials and envelope-encryption keys
- Workers Analytics Engine: usage telemetry and operational analytics

## Primary Database Operating Model

Supabase Postgres is the primary operational database for product-owned relational state, including identity, membership, projects, config metadata, canonical events, audit indexes, usage rollups, billing state, notifications, webhooks, support actions, and optional resource/runtime metadata.

- Workers connect to Supabase Postgres through Hyperdrive bindings. Raw connection strings and Supabase service keys must stay in platform configuration and must not leak into domain logic.
- Terraform must provision the target Supabase project/database for the approved
  environments once the AWS-admin role and S3 backend path are in place. The
  current approved Supabase live environments are `stage` and `prod`; `dev` is
  intentionally deferred.
- The approved Supabase organization is `sourceplane` with slug/id
  `dwazxcrywsdbxpuouifa`. `stage` and `prod` must use separate Supabase
  projects/databases, not one shared project/database.
- Generated database credentials and connection details must be stored in AWS Secrets Manager under `<org>/<repo>/<component>/<env>`.
- Workers that need the primary database must use the configured Hyperdrive binding/resource for their environment instead of inventing ad hoc connection strings.
- Local database verification may use temporary credentials only when the task explicitly allows it. Temporary credentials must never be committed, logged in full, or copied into source files.
- Repository adapters own SQL, pooling assumptions, transaction boundaries, and Hyperdrive-specific behavior. Domain services receive typed repositories or unit-of-work abstractions, not platform database clients.
- Each bounded context owns its schema or table namespace and migration history. Cross-context foreign keys are prohibited; use opaque IDs, service calls, and published events instead.
- Every tenant-scoped table must include `org_id` directly or have an auditable path to `org_id` through a table owned by the same bounded context.
- Domain mutations and outbox/event inserts that describe the same state change should commit atomically in the same Postgres transaction.
- Supabase Auth, Realtime, Storage, and Edge Functions are not platform source-of-truth services unless a future spec explicitly adopts them. Sourceplane-owned identity remains in the identity component.

## Operational Access And Resource Verification

Agents may assume authenticated access to `gh`, to AWS through the
`aws-admin`-managed repo roles, and to `wrangler` or Supabase tooling when a
task explicitly needs provider inspection.

- AWS IAM roles and state buckets are owned by `aws-admin`.
- This repo consumes the `sourceplane/multi-tenant-saas` GitHub OIDC roles and
  must not create IAM roles directly.
- Terraform state uses the shared `sourceplane-<env>` S3 buckets and native S3
  locking, following the `aws-admin` backend contract.
- Secrets are stored in AWS Secrets Manager, not in committed files or
  task/report bodies.
- Any task that creates or updates Cloudflare, Supabase, AWS IAM, S3, or
  Secrets Manager resources must verify the resource exists after creation and
  record non-secret observed state in the implementer or verifier report.
- Verifiers must not rely only on successful command exit codes. They must
  inspect provider state directly when a task claims a live resource or
  permission change.

## Extraction Model

The monorepo is successful only if each bounded context can later move without changing public contracts.

A component is considered extraction-ready when:

- its persistence is owned only by that component,
- its internal consumers reach it only through contracts or service bindings,
- it has its own deployment config,
- it has no domain cross-imports,
- its public and event contracts already live in `packages/contracts`.

When a component outgrows Cloudflare-native storage or queueing:

- keep the public and internal contract stable,
- move its owned Supabase schema/tables or replace the repository adapter,
- optionally front the external service with the same Worker contract,
- keep Hyperdrive or standard outbound connectivity only at the adapter layer.

## Composition and CI Model

This repo uses [orun](https://orun-api.sourceplane.ai) for composition-driven
CI and deployment. The working model is the Orun golden path captured in
`specs/core/orun-golden-path.md`, with `aws-admin` as the reference implementation
for Terraform, S3 backend, and environment structure.

- **`stack-tectonic/`** is the repo-owned operations catalog. Its Terraform
  composition must be brought in line with `../aws-admin/stacks/aws-admin-terraform/`
  before new infra work depends on it.
- **`intent.yaml`** records discovery roots, composition sources and bindings,
  trigger bindings, and `dev` -> `stage` -> `prod` environment promotion. It
  uses `parameterDefaults.terraform` and `env.AWS_REGION` like `aws-admin`.
- **`.orun/`** contains generated local Orun plans, locks, and run state. It is
  ignored by git; `kiox.lock` is the committed runtime/provider lock.
- **`component.yaml`** in each app, package, infra module, and test suite
  describes the composition type, environment subscriptions, typed parameters,
  labels, and dependencies. No component is wired into the CI workflow directly.
- **`kiox.yaml`** pins the Orun runtime version and should match the current
  `aws-admin` pin.

Composition types used:

| Type                              | Used by                                           |
| --------------------------------- | ------------------------------------------------- |
| `cloudflare-worker-turbo`         | All Workers in `apps/` except `web-console-next`  |
| `cloudflare-workers-assets-turbo` | `apps/web-console-next` (Next.js + Static Assets) |
| `turbo-package`                   | Shared packages in `packages/`                    |
| `turbo-test`                      | Test suites in `tests/components/`                |
| `terraform`                       | Optional repo-owned infra components in `infra/`  |

The immediate operations tasks are to align the local Orun runtime and
Stack Tectonic contracts with `aws-admin`, delete deprecated R2/core Terraform
component source, add the missing AWS-admin IAM role component for this repo,
establish S3 backend usage with the shared `sourceplane-<env>` buckets, and
then add fresh Supabase infrastructure as a Terraform component.

The base commands stay portable between local execution and GitHub Actions:

- `kiox -- orun validate --intent intent.yaml`
- `kiox -- orun plan --changed --intent intent.yaml --output plan.json`
- `kiox -- orun run --plan plan.json --job <job-id>`

GitHub Actions may add matrix-selected `--job`, `--runner github-actions`, and
remote-state flags, but it must not swap to a different task runner or a
different job graph.

The CI workflow (`ci.yml`) compiles one Orun plan on every PR and push to main, uploads the plan artifact, and fans out `orun run` jobs per selected component or test component. Deployment lanes are encoded in `intent.yaml` environments — there is no separate hand-maintained deploy graph.

Adding a new app, package, infra module, or test suite requires only a colocated `component.yaml`. The workflow does not need to change.

If a repo-specific composition change is needed:

1. update `stack-tectonic/` first,
2. update the schema/profile/job contract and README together,
3. add or update the matching smoke fixture there when one exists,
4. run local `kiox -- orun validate`, `plan`, and `run --dry-run`,
5. then merge the consuming component change.

## CI And Quality Gates

Every change must pass the gates enforced by the matched Orun component graph:

- lint
- typecheck
- unit tests
- contract tests
- integration tests for the changed component
- downstream smoke tests required by changed dependencies
- local `kiox -- orun validate --intent intent.yaml`
- local `kiox -- orun plan --changed`
- local `kiox -- orun run --plan plan.json --dry-run --runner github-actions`
- GitHub Actions `kiox -- orun run --plan plan.json --job <job-id> --runner github-actions --remote-state`

All test execution that can block merge or release must happen through Orun jobs owned by `tests/components/*`. Standalone `pnpm test` jobs in CI are allowed only when they are invoked by a test component composition, not as a second orchestration path beside Orun.

Changes that affect `packages/contracts`, `specs/`, or shared auth, tenancy, project, billing, audit, resource, or webhook flows require downstream smoke tests for every impacted component.

If `orun plan --changed` produces no component jobs, the matching `orun run --changed` result should be recorded as a no-op instead of skipped silently.
