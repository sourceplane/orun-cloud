# cloudflare-r2

Provisions the Cloudflare R2 bucket consumed by the `state-worker` Worker as
its object/log store. This is the monorepo's **first app-data R2 bucket** — the
platform previously used R2 only for the Terraform-state bucket in `bootstrap`,
so this slice introduces the repo's first `R2Bucket` Worker binding.

The bucket backs the state bounded context (`apps/state-worker`,
`specs/components/18-state.md`): the content-addressed object plane
(`plan` / `catalog-snapshot` / `composition-lock` / `artifact-manifest` blobs)
and the chunked job-log store (saas-orun-platform design §4.1, §4.3).

Future R2-backed features land here as additional `cloudflare_r2_bucket`
resources rather than parallel slices, so backend / provider configuration
stays in one place — exactly as `cloudflare-kv` is the home for KV namespaces.

## Overview

- **What it provisions:** one R2 bucket per environment (`stage`, `prod`),
  named `orun-state-${environment}` (e.g. `orun-state-stage`,
  `orun-state-prod`).
- **What consumes it:** `apps/state-worker` binds the bucket as `ORUN_STATE`
  in `wrangler.jsonc` (env.stage, env.prod). `env.dev` does NOT receive a
  binding — dev is a verify-only profile with no live worker.
- **Object layout** (owned by the Worker, not Terraform):
  - objects: `state/{orgId}/{projectId}/objects/{digest}`
  - logs: `state/{org}/{project}/runs/{runId}/logs/{jobId}/{seq}`

## Resources Created

| Resource | Per-env | Description |
|---|---|---|
| `cloudflare_r2_bucket.orun_state` | stage, prod | R2 bucket bound to the `state-worker` Worker as `ORUN_STATE` |

## Parameters

Standard Orun parameters (matching `cloudflare-kv`):

| Name | Type | Default | Description |
|---|---|---|---|
| `awsRegion` | string | `us-east-1` | AWS region for Terraform state backend |
| `cloudflare_api_token` | string (sensitive) | `""` | From `CLOUDFLARE_API_TOKEN` env var |
| `cloudflare_account_id` | string (sensitive) | `""` | From `CLOUDFLARE_ACCOUNT_ID` env var |
| `orgName` | string | `sourceplane` | Org identifier |
| `owner` | string | `sourceplane` | GitHub owner |
| `repo` | string | `orun-cloud` | GitHub repo |
| `namespace` | string | `sourceplane` | Logical namespace |
| `namespacePrefix` | string | `""` | Stage/prod prefix |
| `lane` | string | `verify` | Orun lane |
| `environment` | string | `stage` | Target environment |
| `component` | string | `cloudflare-r2` | Component identifier |
| `stackName` | string | `cloudflare-r2` | Stack identifier |
| `terraformDir` | string | `terraform` | Terraform module dir |
| `terraformVersion` | string | `1.15.3` | Terraform version |
| `r2_location_hint` | string | `ENAM` | R2 location hint (WNAM/ENAM/WEUR/EEUR/APAC/OC); immutable after create |

## Outputs

| Output | Description | Use |
|---|---|---|
| `orun_state_bucket_name` | R2 bucket name | Bound from `apps/state-worker/wrangler.jsonc` `r2_buckets[*].bucket_name`. R2 binds by NAME, not id. |
| `wiring_secret_arn` | ARN of the wiring-manifest secret | BF6 deploy-time wiring resolution |

## Dependencies

- **Cloudflare credentials**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
  must be in scope (Orun CI provides them). The token needs Workers R2 Storage
  write permission on the target account.
- **No upstream Terraform component**: this slice does not consume any AWS
  Secrets Manager value or other component output. It is a peer of
  `cloudflare-hyperdrive` and `cloudflare-kv`, not a downstream consumer.

## Environments

| Environment | Profile (default) | Profile (push-main) | Notes |
|---|---|---|---|
| `stage` | `plan-only` | `apply` | Plan on PR, apply on merge |
| `prod` | `plan-only` | `apply` | Plan on PR, apply on merge |
| `dev` | n/a | n/a | Not subscribed; state-worker dev profile has no R2 binding |

`prod` waits on `stage` per `intent.yaml#environments.prod.promotion.dependsOn`.

## Secret Storage

- R2 bucket names are NOT secrets and are surfaced as Terraform outputs +
  embedded in `apps/state-worker/wrangler.jsonc`.
- The Cloudflare API token / account ID stay sensitive Terraform variables;
  never logged, never echoed to outputs.
- Object bytes are stored encrypted at rest by Cloudflare. The Worker is the
  only writer; CAS objects are content-addressed and digest-verified on PUT.

## Configuration Details

- **Provider pin**: `cloudflare ~> 4.30` — matches the repo posture
  (`cloudflare-kv` / `cloudflare-hyperdrive` resolve to `4.52.7`). The deferred
  v4→v5 upgrade owns the migration. **Do not edit the pin here.**
- **AWS provider pin**: `aws ~> 5.0`, matching peer slices.
- **Terraform backend**: shared S3 backend, key supplied at runtime by Orun
  (`workspace_key_prefix = "env"`).
- **Location hint**: set once at create (`r2_location_hint`, default `ENAM`);
  R2 treats it as immutable, so changing it later forces a replace.

## Local Verification

```bash
# Terraform fmt check
terraform -chdir=infra/terraform/cloudflare-r2/terraform fmt -check
```

## Security

- Credentials: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` only via env
  vars; never committed.
- State: encrypted S3 backend with `use_lockfile = true`.
- Audit: bucket creation visible in the Cloudflare dashboard audit log.

## Related Components

- **cloudflare-hyperdrive**: pattern template; the Postgres index that pairs
  with this object store (the state plane is R2 blobs + Postgres index rows).
- **cloudflare-kv**: sibling first-of-its-kind storage slice; the home pattern
  this module follows.
- **state-worker** (`apps/state-worker`): the sole consumer, binding the
  bucket as `ORUN_STATE`.
