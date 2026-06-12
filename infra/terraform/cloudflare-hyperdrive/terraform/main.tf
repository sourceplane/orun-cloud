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
  description = "Cloudflare API token with Hyperdrive permissions (from CLOUDFLARE_API_TOKEN env var)"
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
  default = "cloudflare-hyperdrive"
}

variable "stackName" {
  type    = string
  default = "cloudflare-hyperdrive"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# --- Data sources ---

# Fetch Supabase connection details from AWS Secrets Manager
# Written by the supabase component
data "aws_secretsmanager_secret_version" "supabase" {
  secret_id = "${var.orgName}/${var.repo}/supabase/${var.environment}"
}

locals {
  supabase_secret = jsondecode(data.aws_secretsmanager_secret_version.supabase.secret_string)

  database_host = local.supabase_secret.database_host
  database_port = tonumber(local.supabase_secret.database_port)
  database_name = local.supabase_secret.database_name
  database_user = local.supabase_secret.database_user

  hyperdrive_name = "${var.namespacePrefix}multi-tenant-saas-${var.environment}"
}

# --- Fetch Cloudflare account ID from env or variable ---
# In Orun CI, CLOUDFLARE_ACCOUNT_ID is available as an env var
# We pass it through as a TF_VAR_cloudflareAccountId
# For local testing, it can be hardcoded or passed via -var

# --- Create Hyperdrive resource ---

resource "cloudflare_hyperdrive_config" "postgres" {
  account_id = var.cloudflare_account_id
  name       = local.hyperdrive_name

  origin = {
    scheme   = "postgres"
    host     = local.database_host
    port     = local.database_port
    database = local.database_name
    user     = local.database_user
    password = local.supabase_secret.database_password
  }

  caching = {
    disabled = false
  }
}

# --- Wiring manifest (BF5) ---
# Publish the consumable outputs of this component at the conventional
# `<org>/<repo>/<component>/<env>` Secrets Manager path so downstream consumers
# (BF6 deploy-time wiring) resolve resource IDs from here instead of committed
# literals. Stable secret container + rotating version, mirroring the supabase
# component's pattern.

resource "aws_secretsmanager_secret" "wiring" {
  name        = "${var.orgName}/${var.repo}/${var.component}/${var.environment}"
  description = "Wiring outputs of the cloudflare-hyperdrive component (consumed by Worker deploy-time binding resolution)"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "wiring" {
  secret_id = aws_secretsmanager_secret.wiring.id
  secret_string = jsonencode({
    hyperdrive_id   = cloudflare_hyperdrive_config.postgres.id
    hyperdrive_name = cloudflare_hyperdrive_config.postgres.name
  })
}

# --- Outputs (non-secret) ---

output "wiring_secret_arn" {
  description = "ARN of the wiring-manifest secret for this component/environment"
  value       = aws_secretsmanager_secret.wiring.arn
}

output "hyperdrive_id" {
  description = "Cloudflare Hyperdrive config ID"
  value       = cloudflare_hyperdrive_config.postgres.id
}

output "hyperdrive_name" {
  description = "Cloudflare Hyperdrive config name"
  value       = cloudflare_hyperdrive_config.postgres.name
}

output "hyperdrive_connection_string" {
  description = "Hyperdrive-formatted connection string for Workers (to be used in bindings)"
  # Note: actual connection string is built at binding time; this is the resource ID
  value = "hyperdrive://${cloudflare_hyperdrive_config.postgres.id}"
}

output "database_host" {
  description = "Database host (from Supabase secrets)"
  value       = local.database_host
  sensitive   = true
}

output "database_port" {
  description = "Database port (from Supabase secrets)"
  value       = local.database_port
  sensitive   = true
}

output "database_name" {
  description = "Database name (from Supabase secrets)"
  value       = local.database_name
  sensitive   = true
}

output "database_user" {
  description = "Database user (from Supabase secrets)"
  value       = local.database_user
  sensitive   = true
}
