terraform {
  required_version = ">= 1.15.0"

  backend "s3" {
    encrypt              = true
    use_lockfile         = true
    workspace_key_prefix = "env"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.30"
    }
  }
}

# --- Providers ---

provider "aws" {
  region = var.awsRegion

  default_tags {
    tags = {
      ManagedBy   = "terraform"
      Repository  = "${var.owner}/${var.repo}"
      Component   = var.component
      Environment = var.environment
    }
  }
}

# Authenticates via CLOUDFLARE_API_TOKEN env var
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# --- Variables (standard Orun parameters) ---

variable "awsRegion" {
  type    = string
  default = "us-east-1"
}

variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare API token with Workers R2 Storage permissions (from CLOUDFLARE_API_TOKEN env var)"
}

variable "cloudflare_account_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare account ID (from CLOUDFLARE_ACCOUNT_ID env var)"
}

variable "orgName" {
  type    = string
  default = "sourceplane"
}

variable "owner" {
  type    = string
  default = "sourceplane"
}

variable "repo" {
  type    = string
  default = "orun-cloud"
}

variable "namespace" {
  type    = string
  default = "sourceplane"
}

variable "namespacePrefix" {
  type    = string
  default = ""
}

variable "lane" {
  type    = string
  default = "verify"
}

variable "environment" {
  type    = string
  default = "stage"
}

variable "component" {
  type    = string
  default = "cloudflare-r2"
}

variable "stackName" {
  type    = string
  default = "cloudflare-r2"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

variable "r2_location_hint" {
  type        = string
  default     = "ENAM"
  description = "R2 bucket location hint (one of WNAM, ENAM, WEUR, EEUR, APAC, OC). Set once at create; immutable after."
}

# --- R2 bucket for the state-worker object/log store ---
#
# The platform's first app-data R2 bucket (today only the Terraform-state
# bucket in `bootstrap` exists). Backs the state-worker (component 18) object
# plane — content-addressed plan / catalog-snapshot / composition-lock /
# artifact-manifest blobs — and chunked job logs:
#   state/{orgId}/{projectId}/objects/{digest}
#   state/{org}/{project}/runs/{runId}/logs/{jobId}/{seq}
# (saas-orun-platform design §4.1, §4.3). One bucket per environment, bound to
# the Worker as `ORUN_STATE` in wrangler.jsonc.

locals {
  state_bucket_name = "orun-state-${var.environment}"
}

resource "cloudflare_r2_bucket" "orun_state" {
  account_id = var.cloudflare_account_id
  name       = local.state_bucket_name
  location   = upper(var.r2_location_hint)
}

# --- Wiring manifest (BF5) ---
# Publish the consumable outputs at the conventional
# `<org>/<repo>/<component>/<env>` Secrets Manager path so downstream consumers
# (BF6 deploy-time wiring) resolve from here. R2 buckets bind by NAME (not id),
# so the bucket name is the consumable value. Stable secret container +
# rotating version, mirroring the cloudflare-kv component's pattern.

resource "aws_secretsmanager_secret" "wiring" {
  name        = "${var.orgName}/${var.repo}/${var.component}/${var.environment}"
  description = "Wiring outputs of the cloudflare-r2 component (consumed by Worker deploy-time R2 binding resolution)"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "wiring" {
  secret_id = aws_secretsmanager_secret.wiring.id
  secret_string = jsonencode({
    orun_state_bucket_name = cloudflare_r2_bucket.orun_state.name
  })
}

# --- Outputs (non-secret) ---

output "wiring_secret_arn" {
  description = "ARN of the wiring-manifest secret for this component/environment"
  value       = aws_secretsmanager_secret.wiring.arn
}

output "orun_state_bucket_name" {
  description = "Cloudflare R2 bucket name bound to the state-worker as ORUN_STATE"
  value       = cloudflare_r2_bucket.orun_state.name
}
