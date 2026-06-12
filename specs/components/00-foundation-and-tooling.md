# Foundation And Tooling

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- repo root
- `tooling/*`
- `infra/*`
- `.github/workflows/ci.yml`
- `tests/*`
- initial scaffolds under `apps/*` and `packages/*`

Primary dependencies:

- `specs/core/constitution.md`
- `specs/core/product-overview.md`
- `specs/core/repo.md`
- `specs/core/access-and-infra.md`

## Intent

Bootstrap a production-grade Cloudflare monorepo that all later SaaS starter bounded contexts can safely build on without reworking the workspace layout.

## Scope

- `pnpm` workspace setup
- task runner setup
- TypeScript base config
- linting, formatting, testing, and typechecking setup
- Worker and Pages app scaffolds
- shared environment typing
- Supabase Postgres and Hyperdrive adapter conventions
- Terraform provisioning for Supabase, Hyperdrive, Worker infra, AWS Secrets Manager secrets, and the S3 backend baseline
- local development scripts
- Orun and Stack Tectonic CI/deploy pipeline skeleton
- root `intent.yaml`, `kiox.yaml`, committed `kiox.lock`, and local `stack-tectonic/`
- `component.yaml` scaffolds for apps, packages, infra, and test components
- contract-test harness wired to `packages/contracts`

## Out Of Scope

- domain business logic
- product UI implementation
- payment-provider integration

## Hard Contracts To Honor

- The repo shape in `specs/core/repo.md`
- The constitutional rule that bounded contexts must remain extractable

## Required Capabilities

### Workspace

- Root scripts for `dev`, `build`, `test`, `lint`, `typecheck`, and `deploy`.
- Per-app scripts for local Cloudflare development and deployment.
- Shared tsconfig and eslint configs that can be extended, not copied.
- Root scripts may wrap local tasks, but CI must call Orun instead of package scripts directly.

### Orun Structure

- `intent.yaml` discovers `apps/`, `packages/`, `tests/`, and `infra/`.
- `intent.yaml` follows the `aws-admin` environment model: `dev`, `stage`, `prod`, promotion gates, `parameterDefaults.terraform`, and `AWS_REGION`.
- `intent.yaml` points at the repo's selected Stack Tectonic composition source and binds component types centrally.
- `stack-tectonic/` is aligned with `../aws-admin/stacks/aws-admin-terraform/` for Terraform schema, jobs, profiles, README style, and local/CI behavior before new infra components depend on it.
- `kiox.yaml` pins the same Orun runtime version as `aws-admin`.
- `kiox.yaml` pins the Orun provider image and `kiox.lock` records the resolved digest.
- `.orun/` contains generated local plans, locks, and run state and is not committed.
- Each app, package, infra unit, and test suite has a colocated `component.yaml`.
- Test components start as `turbo-package` components with `labels.layer: test` unless the local stack provides a dedicated test type.

### Testing

- Unit, contract, integration, and smoke suites are represented as Orun test components under `tests/`.
- Contract tests load schemas from `packages/contracts`.
- Worker-to-Worker integration tests use a dedicated test component for each surface.
- App and package components that require tests declare `dependsOn` on their matching test component.
- No GitHub Actions job may run test commands directly.

### Environment Management

- Typed env bindings for Workers.
- Typed Hyperdrive bindings for Workers that need the primary Supabase Postgres database.
- Clear separation between local, preview, and production configuration.
- Local, preview, and production database targets must be selected through environment configuration, not hardcoded connection strings.
- Secrets must be referenced through Wrangler and Secrets Store conventions, not `.env` files committed to git.

### Infrastructure Provisioning

- Terraform provisions the target Supabase database/project and Cloudflare runtime resources through Orun jobs.
- The current Supabase provisioning target is `stage` and `prod` only, under
  Supabase organization `sourceplane` (`dwazxcrywsdbxpuouifa`), with one
  separate project/database per environment. `dev` is intentionally deferred.
- Terraform state uses AWS S3 backend buckets `sourceplane-<env>` with native S3 locking, matching `aws-admin`.
- Infra provisioning is exposed as Orun components under `infra/terraform`.
- AWS IAM roles, S3 state buckets, and the multi-tenant SaaS repo permissions are created in `aws-admin`.
- Generated database credentials and connection details are written to AWS Secrets Manager under `<org>/<repo>/<component>/<env>`.
- CI assumes the `aws-admin`-created repo role through OIDC before Terraform needs AWS access.
- No GitHub Actions job may run Terraform directly outside Orun.

### CI

- Run `orun plan --changed --intent intent.yaml --output plan.json` on every PR and push to main.
- Fan out `orun run --plan plan.json --runner github-actions --remote-state --job ...` from the immutable plan.
- Use `contents: read`, `packages: read`, and `id-token: write` workflow permissions.
- Support targeted validation and deploys by changed component.

## Agent Freedom

- The agent may choose `turbo`, `nx`, or a simpler task graph if it still supports selective execution well.
- The agent may choose `vitest` or another TypeScript-friendly test runner if Worker support is solid.
- The agent may choose exact folder helpers and codegen scripts as long as the repo shape remains compatible with `specs/core/repo.md`.

## Acceptance Criteria

- The first merged implementation task materializes the Orun repo structure before domain code.
- A fresh clone can install, typecheck, lint, and run tests through Orun components.
- At least one Worker and one Pages app scaffold run locally.
- `packages/contracts` can publish shared validators/types to other packages.
- New bounded contexts can be added without editing unrelated app internals.
- Local verification passes:

```bash
kiox -- orun compositions lock --intent intent.yaml
kiox -- orun validate --intent intent.yaml
kiox -- orun plan --changed --intent intent.yaml --output plan.json
kiox -- orun run --plan plan.json --dry-run --runner github-actions
```

- GitHub Actions uses the same Orun plan/run model and executes at least one test component.
- A test-only change produces a test component job in the Orun matrix.
- Infra changes run Terraform plan/apply through Orun with S3-backed state.
- Supabase database creation, secret writes, and Cloudflare/Hyperdrive wiring are verified against live provider state when they are in task scope.

## Extraction Seam

This component must avoid hidden global assumptions. Later extractions should be able to move an app plus a small set of packages without rebuilding the entire workspace model.
