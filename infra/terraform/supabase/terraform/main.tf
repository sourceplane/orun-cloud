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
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
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

# Authenticates via SUPABASE_ACCESS_TOKEN env var (mapped from SUPABASE_API_KEY in CI)
provider "supabase" {}

# --- Variables (standard Orun parameters) ---

variable "awsRegion" {
  type    = string
  default = "us-east-1"
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
  default = "supabase"
}

variable "stackName" {
  type    = string
  default = "supabase"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# Supabase target identity — supplied as TF_VAR_supabaseOrgId / TF_VAR_supabaseRegion
# from the component's `spec.parameters` (see infra/terraform/supabase/component.yaml).
# Required (no default) so a missing value fails plan loudly instead of silently
# pointing at the wrong Supabase organization or region.
variable "supabaseOrgId" {
  type = string
}

variable "supabaseRegion" {
  type = string
}

# --- Locals ---

locals {
  supabase_org_id = var.supabaseOrgId
  supabase_region = var.supabaseRegion
  project_name    = "multi-tenant-saas-${var.environment}"
  secret_name     = "${var.orgName}/multi-tenant-saas/supabase/${var.environment}"

  supabase_secret_payload = {
    project_ref       = supabase_project.this.id
    project_url       = "https://${supabase_project.this.id}.supabase.co"
    database_host     = "db.${supabase_project.this.id}.supabase.co"
    database_port     = "5432"
    database_name     = "postgres"
    database_user     = "postgres"
    database_password = random_password.db_password.result
    connection_uri    = "postgresql://postgres:${random_password.db_password.result}@db.${supabase_project.this.id}.supabase.co:5432/postgres"
  }
}

# --- Generate database password ---

resource "random_password" "db_password" {
  length  = 32
  special = true
  # Avoid characters that cause issues in connection strings
  override_special = "!#$%&*()-_=+[]{}|:,.<>?"
}

# --- Supabase project ---

resource "supabase_project" "this" {
  organization_id   = local.supabase_org_id
  name              = local.project_name
  database_password = random_password.db_password.result
  region            = local.supabase_region
}

# --- Store credentials in AWS Secrets Manager ---

resource "aws_secretsmanager_secret" "supabase" {
  name                    = local.secret_name
  description             = "Supabase project credentials for ${local.project_name}"
  recovery_window_in_days = 30

  tags = {
    Project     = local.project_name
    Environment = var.environment
  }

  lifecycle {
    # Keep the named secret as a stable container. Credential changes must create
    # a new aws_secretsmanager_secret_version rather than replacing the secret,
    # because AWS prevents immediate reuse of a deleted secret name during the
    # recovery window.
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "supabase" {
  secret_id      = aws_secretsmanager_secret.supabase.id
  secret_string  = jsonencode(local.supabase_secret_payload)
  version_stages = ["AWSCURRENT"]
}

# --- Outputs (non-secret only) ---

output "project_ref" {
  description = "Supabase project reference ID"
  value       = supabase_project.this.id
}

output "project_name" {
  description = "Supabase project name"
  value       = supabase_project.this.name
}

output "project_url" {
  description = "Supabase project URL"
  value       = "https://${supabase_project.this.id}.supabase.co"
}

output "secret_arn" {
  description = "ARN of the AWS Secrets Manager secret storing credentials"
  value       = aws_secretsmanager_secret.supabase.arn
}

output "database_password" {
  description = "Generated database password (sensitive)"
  value       = random_password.db_password.result
  sensitive   = true
}
