# cloudflare-domain composition

Manages Cloudflare DNS zones and custom domain attachments for Pages and Worker
projects via Terraform.

## Component Type

`cloudflare-domain`

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `stackName` | yes | Terraform stack identifier |
| `terraformDir` | yes | Path to Terraform root relative to component |
| `terraformVersion` | yes | Terraform CLI version |
| `baseDomain` | yes | Root domain (e.g. `sourceplane.ai`) |
| `zoneMode` | yes | `existing` to adopt a zone already in Cloudflare; `managed` to create/manage the zone lifecycle |
| `pagesCustomDomains` | no | Map of hostname → Pages project name |
| `workerCustomDomains` | no | Map of hostname → Worker script name |
| `awsRegion` | no | AWS region for state backend |
| `orgName` | no | Organization name for state bucket |
| `owner` | no | GitHub repository owner |
| `repo` | no | GitHub repository name |

## Zone Modes

### `existing` (adopt)

Use when the domain is already added to a Cloudflare account. The Terraform
module uses `data.cloudflare_zone` to look up the zone by name. No zone
creation or deletion occurs.

### `managed` (create)

Use when the domain has not been added to Cloudflare. The Terraform module
creates a `cloudflare_zone` resource and manages its full lifecycle. Delegation
(NS records at the registrar) must be completed manually after the first apply.

## Profiles

- **plan-only**: Runs fmt, init, validate, plan. Used for PR validation.
- **apply**: Full plan + apply. Used on `github-push-main` trigger only.

## Outputs

Non-secret outputs reported by the Terraform module:

- `zone_id` — Cloudflare zone identifier
- `zone_name` — Domain name of the zone
- `zone_status` — Zone activation status
- `pages_custom_domains` — Map of attached Pages custom domain hostnames and statuses
