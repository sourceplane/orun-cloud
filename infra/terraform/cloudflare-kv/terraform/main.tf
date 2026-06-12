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
  description = "Cloudflare API token with Workers KV permissions (from CLOUDFLARE_API_TOKEN env var)"
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
  default = "multi-tenant-saas"
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
  default = "cloudflare-kv"
}

variable "stackName" {
  type    = string
  default = "cloudflare-kv"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# --- KV namespace for api-edge idempotency replay store ---
#
# Backs the Stripe-style idempotency replay store added in Task 0095. Keys are
# scoped (orgId|"anon", routePath, idempotencyKey) and entries TTL'd via the
# api-edge Worker (`expirationTtl: 86400`); no Terraform-side TTL knob exists
# for KV namespaces themselves — TTL is per-PUT, owned by the Worker.

locals {
  idempotency_namespace_title = "${var.namespacePrefix}api-edge-idempotency-${var.environment}"
}

resource "cloudflare_workers_kv_namespace" "api_edge_idempotency" {
  account_id = var.cloudflare_account_id
  title      = local.idempotency_namespace_title
}

# --- Wiring manifest (BF5) ---
# Publish the consumable outputs of this component at the conventional
# `<org>/<repo>/<component>/<env>` Secrets Manager path so downstream consumers
# (BF6 deploy-time wiring) resolve resource IDs from here instead of committed
# literals. Stable secret container + rotating version, mirroring the supabase
# component's pattern.

resource "aws_secretsmanager_secret" "wiring" {
  name        = "${var.orgName}/${var.repo}/${var.component}/${var.environment}"
  description = "Wiring outputs of the cloudflare-kv component (consumed by Worker deploy-time binding resolution)"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "wiring" {
  secret_id = aws_secretsmanager_secret.wiring.id
  secret_string = jsonencode({
    api_edge_idempotency_kv_id    = cloudflare_workers_kv_namespace.api_edge_idempotency.id
    api_edge_idempotency_kv_title = cloudflare_workers_kv_namespace.api_edge_idempotency.title
  })
}

# --- Outputs (non-secret) ---

output "wiring_secret_arn" {
  description = "ARN of the wiring-manifest secret for this component/environment"
  value       = aws_secretsmanager_secret.wiring.arn
}

output "api_edge_idempotency_kv_id" {
  description = "Cloudflare Workers KV namespace ID for api-edge idempotency replay store"
  value       = cloudflare_workers_kv_namespace.api_edge_idempotency.id
}

output "api_edge_idempotency_kv_title" {
  description = "Cloudflare Workers KV namespace title (human-readable identifier)"
  value       = cloudflare_workers_kv_namespace.api_edge_idempotency.title
}
