# Bootstrap Terraform Component

Minimal Terraform component that proves the AWS S3 backend and Secrets Manager
access path for `multi-tenant-saas` Terraform components.

## Purpose

- Validates that the OIDC-assumed IAM roles from `aws-admin` (Task 0004) work
  correctly for this repository.
- Confirms S3 state bucket read/write access.
- Establishes the pattern for future Terraform components (e.g., Supabase in
  Task 0006).

## Backend

| Setting              | Value                                                    |
| -------------------- | -------------------------------------------------------- |
| Bucket               | `sourceplane-<environment>`                              |
| Key                  | `multi-tenant-saas/bootstrap/terraform.tfstate`          |
| workspace_key_prefix | `env`                                                    |
| encrypt              | `true`                                                   |
| use_lockfile         | `true`                                                   |
| Region               | `us-east-1`                                              |

Effective state path: `env/<environment>/multi-tenant-saas/bootstrap/terraform.tfstate`

## AWS Roles

Credential assumption is handled by the Orun Terraform composition
(`stack-tectonic/compositions/terraform/`) via `aws-actions/configure-aws-credentials@v4`.

The account ID and `owner`/`repo` are not hard-coded in the composition: the
role ARN is rendered from `{{.parameters.awsAccountId}}` (set in `intent.yaml`
under `parameterDefaults.terraform`, and in `infra/db-migrate/component.yaml`
for the migration runner) plus `{{.parameters.owner}}`/`{{.parameters.repo}}`.

| Profile   | Role                                                                              |
| --------- | --------------------------------------------------------------------------------- |
| plan-only | `arn:aws:iam::<awsAccountId>:role/<env>-github-<owner>-<repo>-plan`                |
| apply     | `arn:aws:iam::<awsAccountId>:role/<env>-github-<owner>-<repo>-production-deploy`   |

> **Note:** The deploy role requires GitHub environment `production` in the
> workflow. Apply behavior is gated on this environment being configured in the
> repository settings.

## Secrets Manager

The deploy role has write access to secrets under the prefix:
`sourceplane/multi-tenant-saas/*`

Smoke verification uses `dev` only to avoid production artifacts.
