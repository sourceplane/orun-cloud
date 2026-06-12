# Terraform Composition

Repo-local Orun composition for Terraform infrastructure components.

## Contract

| Field | Value |
| --- | --- |
| Type | `terraform` |
| Schema | `schema.yaml` |
| Default Profile | `apply` |
| Profiles | `plan-only`, `apply` |

## Parameters (from schema)

| Parameter | Required | Description |
| --- | --- | --- |
| `stackName` | yes | Logical name of the Terraform stack |
| `terraformDir` | yes | Relative path to the Terraform root module |
| `terraformVersion` | yes | Pinned Terraform CLI version |
| `orgName` | no | Organization name (used for S3 bucket naming) |
| `awsRegion` | no | AWS region override |
| `owner` | no | GitHub org owner |
| `repo` | no | GitHub repo name |
| `namespace` | no | Logical namespace |
| `namespacePrefix` | no | Environment-scoped prefix |
| `lane` | no | Deployment lane |

## Profiles

### `plan-only`

Non-mutating validation: setup, env export, fmt, init, workspace, validate, plan.
Used on pull requests to preview changes without acquiring state locks.

### `apply`

Full lifecycle: setup, env export, fmt, init, workspace, validate, plan, apply.
Used on main-branch pushes when profile rules select it.

## Job Steps

1. **setup-terraform** — Install pinned Terraform version
2. **terraform-env** — Export `TF_VAR_*` from component parameters and environment
3. **terraform-context** — Print version and component metadata
4. **terraform-fmt-check** — Enforce canonical formatting
5. **terraform-init** — Initialize with S3 backend config
6. **terraform-workspace** — Select or create environment workspace
7. **terraform-validate** — Validate configuration
8. **terraform-plan** — Generate execution plan
9. **terraform-apply** — Apply changes (only in `apply` profile)

## S3 Backend Convention

```
bucket: {orgName}-{environment}
key:    {repo}/{componentName}/terraform.tfstate
region: {awsRegion}
```

Note: S3 backend consumption requires IAM roles from `aws-admin` (Task 0004/0005).
Until then, `terraform init` will fail on live runs but `orun validate` and
`orun plan` will succeed.

## Local Verification

```bash
kiox -- orun compositions --intent intent.yaml --long
kiox -- orun validate --intent intent.yaml
```
