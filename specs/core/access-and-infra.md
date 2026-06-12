# Access And Infrastructure Spec

Status: Normative

## Intent

Define the access, Terraform, remote-state, and secret-storage model for the
multi-tenant SaaS repo. This repo follows the same Orun golden-path shape as
`aws-admin`: component-native Terraform declarations, CI behavior compiled by
Orun, environment behavior visible in `intent.yaml`, and cloud access granted
through repo-scoped AWS roles.

## Golden Path References

- `specs/core/orun-golden-path.md` explains how agents should reason about Orun
  repos.
- `../aws-admin/intent.yaml` is the reference for environment shape:
  `dev`, `stage`, `prod`, promotion gates, `parameterDefaults.terraform`, and
  `AWS_REGION`.
- `../aws-admin/stacks/aws-admin-terraform/` is the reference Terraform
  composition contract for `plan-only` and `apply` profiles.
- `../aws-admin/domains/**/component.yaml` and colocated `README.md` files are
  the reference for component descriptor and component documentation style.

## Agent Access

Agents may assume authenticated access to:

- `gh` for GitHub PRs, checks, logs, and repository inspection.
- AWS through the repo-scoped IAM roles created by `aws-admin`.
- `wrangler` and Supabase tooling only when a task explicitly needs to inspect
  or verify Cloudflare/Supabase resources.

When access is unclear, task agents must pause or record the blocker instead of
inventing account IDs, role ARNs, project refs, or secret names.

## AWS Admin Boundary

`aws-admin` owns AWS IAM and the shared Terraform state buckets. This repo must
not hand-create IAM users, roles, policies, or S3 state buckets.

The required `aws-admin` component for this repo creates environment-scoped
GitHub OIDC roles for `sourceplane/multi-tenant-saas`. Those roles must allow:

- Terraform state read/write against the shared S3 state buckets named
  `sourceplane-<env>`.
- AWS Secrets Manager read/write for this repo's secret namespace:
  `<org>/<repo>/<component>/<env>`.
- Read-only identity and policy inspection needed by Terraform plan jobs.

The role names and trust subjects must follow the same pattern as the existing
`aws-admin` GitHub repository components. The multi-tenant SaaS repo consumes
those roles; it does not own their creation.

## CI Secrets And Identity

GitHub Actions must use OIDC-assumed AWS roles rather than committing or logging
long-lived credentials. If a task temporarily relies on existing AWS access
secrets while migrating, it must record the compatibility reason and remove the
fallback in the smallest safe follow-up.

The baseline CI environment needs:

- `ORUN_BACKEND_URL` for Orun remote execution state.
- GitHub token access supplied by Actions.
- AWS role configuration supplied through the Orun Terraform composition or an
  explicit pre-run credential step that is itself encoded in the Orun-planned
  job behavior.
- `SUPABASE_API_KEY` as a GitHub Actions secret with management access to the
  Supabase `sourceplane` organization. Terraform jobs must map this secret to
  the selected Supabase provider's access-token input without printing it.

Provider-specific credentials, Supabase database passwords, API keys, and
connection strings must live in AWS Secrets Manager under:

```text
<org>/<repo>/<component>/<env>
```

Example:

```text
sourceplane/multi-tenant-saas/supabase/stage
```

Secret values must never be committed, echoed in logs, or copied into task
reports. Reports may include secret names and non-secret resource IDs.

## Terraform State

Terraform state for this repo uses AWS S3, not Cloudflare R2.

All Terraform components must use the same backend contract as `aws-admin`:

- bucket: `<orgName>-<environment>`; for this repo, `sourceplane-dev`,
  `sourceplane-stage`, and `sourceplane-prod`
- key: `<repo>/<component>/terraform.tfstate`
- `workspace_key_prefix = "env"`
- `encrypt = true`
- `use_lockfile = true`
- region supplied from environment or component parameters, defaulting to
  `us-east-1`

The effective state object path is therefore:

```text
env/<environment>/<repo>/<component>/terraform.tfstate
```

The old R2 bootstrap component is deprecated and must be removed from active
repo source by Task 0003.1. That task is source deletion only; it must not
clean up, import, destroy, or otherwise mutate live Cloudflare, R2, Hyperdrive,
Supabase, AWS, or Terraform state resources.

## Terraform Components

Infrastructure provisioning must be represented as Orun-discovered Terraform
components under `infra/terraform/**`.

Minimum target components:

- a Supabase infrastructure component that creates the environment database or
  project resources and stores generated secrets in AWS Secrets Manager;
- Cloudflare infrastructure components that wire Workers, Hyperdrive, queues,
  bindings, or other runtime resources when they become task scope.

Terraform components must follow the `aws-admin` component style:

- `spec.type: terraform`
- `spec.domain` aligned with the repo's intent groups
- typed values under `spec.parameters`
- `terraformDir: terraform`
- pinned `terraformVersion`
- explicit `dependsOn` edges for state, IAM, Supabase, or Cloudflare ordering
- `plan-only` by default, with `apply` selected by profile rules on the merge
  trigger
- a colocated `README.md` with metadata, purpose, resources, parameters,
  outputs, usage, dependencies, and operational notes

## Supabase Ownership

Supabase Postgres is the primary relational database for product-owned state.
New environment databases or Supabase projects must be created by Terraform
through Orun jobs after AWS access and S3 state are in place.

The current Supabase target decision is:

- Organization/account name: `sourceplane`
- Supabase organization slug/id: `dwazxcrywsdbxpuouifa`
- Task 0006 provisions only `stage` and `prod`.
- `dev` is intentionally not provisioned for now and must not be added to the
  Supabase Terraform component without a later task.
- `stage` and `prod` each get a separate Supabase project and therefore a
  separate primary Postgres database. Do not use branches or a shared
  project/database for these environments.
- Project names should follow `<repo>-<env>`:
  `multi-tenant-saas-stage` and `multi-tenant-saas-prod`.
- Project refs are assigned by Supabase during creation and must be recorded as
  non-secret outputs/report values after apply.

The Supabase infrastructure component must:

- generate database credentials through Terraform;
- authenticate through the Supabase provider using the GitHub
  `SUPABASE_API_KEY` secret in CI and a local equivalent only when running
  approved local verification;
- avoid logging generated passwords or API keys;
- write connection details and generated credentials to AWS Secrets Manager
  under `<org>/<repo>/<component>/<env>`;
- expose only non-secret outputs in Terraform outputs and reports;
- leave Worker/Hyperdrive wiring either in the same clearly scoped Terraform
  component or in a dependent Cloudflare infra component.

Existing human-provided Cloudflare/Supabase resources may be inspected for
migration context, but the target path is Terraform-owned infrastructure with
S3 state and AWS Secrets Manager as the secret system of record.

## Orun Execution

All infrastructure plan/apply behavior must run through Orun. Direct Terraform,
Supabase, Wrangler, or AWS apply commands in GitHub Actions are prohibited
unless they are emitted by an Orun composition job.

Required validation for infrastructure changes:

```bash
kiox -- orun validate --intent intent.yaml
kiox -- orun plan --intent intent.yaml --view dag
kiox -- orun plan --intent intent.yaml --output plan.json
kiox -- orun run --plan plan.json --dry-run --runner github-actions
```

Use `--changed` when proving PR scoping, and use full plans when validating
environment promotion or cross-component dependency behavior.

## Acceptance Criteria

- `multi-tenant-saas` uses the Orun runtime pinned in `kiox.yaml`
  (authoritative; `kiox.lock` records the resolved digest) while continuing to
  follow `aws-admin` for Terraform component and backend structure.
- `intent.yaml` uses the `dev`, `stage`, `prod` environment shape and
  Terraform parameter defaults from the AWS-admin pattern.
- Terraform state uses S3 buckets `sourceplane-<env>` and the AWS-admin state
  key pattern.
- AWS-admin-created roles allow the multi-tenant SaaS CI path to read/write its
  Secrets Manager namespace and Terraform state.
- Supabase `stage` and `prod` projects are separate, Terraform-created projects
  under organization `sourceplane` (`dwazxcrywsdbxpuouifa`), and their generated
  database credentials are stored in AWS Secrets Manager.
- CI and local `kiox -- orun ...` behavior are verified from rendered plans,
  not inferred from file names.
- Resource creation or permission changes are verified against live provider
  state before merge.
