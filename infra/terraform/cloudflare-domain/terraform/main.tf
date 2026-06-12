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
      version = "~> 4.52"
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
  description = "Cloudflare API token (from CLOUDFLARE_API_TOKEN env var)"
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
  default = "cloudflare-domain"
}

variable "stackName" {
  type    = string
  default = "cloudflare-domain"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# --- Domain variables (from intent.yaml env and component parameters) ---

variable "baseDomain" {
  type        = string
  default     = "orun.dev"
  description = "Root domain to manage (from BASE_DOMAIN env or component parameter)"
}

variable "zoneMode" {
  type        = string
  default     = "existing"
  description = "Zone management mode: 'existing' adopts zone, 'managed' creates it"
  validation {
    condition     = contains(["existing", "managed"], var.zoneMode)
    error_message = "zoneMode must be 'existing' or 'managed'."
  }
}

variable "workerNamePrefix" {
  type        = string
  default     = "orun-web-console-next"
  description = "Worker name prefix for the new console; full Worker service name is {prefix}-{environment}"
}

variable "CONSOLE_CUSTOM_DOMAIN" {
  type        = string
  default     = ""
  description = "Custom domain for the console (from CONSOLE_CUSTOM_DOMAIN env var via TF_VAR)"
}

# --- Locals ---

locals {
  console_custom_domain = var.CONSOLE_CUSTOM_DOMAIN
  worker_name           = "${var.workerNamePrefix}-${var.environment}"
  has_custom_domain     = local.console_custom_domain != ""
}

# --- Zone lookup (existing mode) ---

data "cloudflare_zone" "existing" {
  count = var.zoneMode == "existing" ? 1 : 0
  name  = var.baseDomain
}

# --- Zone creation (managed mode) ---

resource "cloudflare_zone" "managed" {
  count      = var.zoneMode == "managed" ? 1 : 0
  account_id = var.cloudflare_account_id
  zone       = var.baseDomain
  plan       = "free"
}

locals {
  zone_id     = var.zoneMode == "existing" ? data.cloudflare_zone.existing[0].id : cloudflare_zone.managed[0].id
  zone_name   = var.baseDomain
  zone_status = var.zoneMode == "existing" ? data.cloudflare_zone.existing[0].status : cloudflare_zone.managed[0].status
}

# --- Worker custom domain attachment ---
#
# Fork note (orun-cloud, 2026-06-12): the baseline fenced this resource
# mid-migration (Task 0085a dropped the v4 state entry; the 0085b v5
# re-import never landed here). This fork has CLEAN state and no live
# custom-domain resource, so the v4 `cloudflare_workers_domain` resource is
# simply active again under the ~> 4.52 pin. When this repo upgrades the
# provider to v5, rename to `cloudflare_workers_custom_domain` with a state
# move at that time (no live-resource migration needed beyond the rename).

resource "cloudflare_workers_domain" "console" {
  count = local.has_custom_domain ? 1 : 0

  account_id  = var.cloudflare_account_id
  zone_id     = local.zone_id
  hostname    = local.console_custom_domain
  service     = local.worker_name
  environment = "production"
}

# --- Outputs (non-secret) ---

output "zone_id" {
  description = "Cloudflare zone ID"
  value       = local.zone_id
}

output "zone_name" {
  description = "Cloudflare zone name"
  value       = local.zone_name
}

output "zone_status" {
  description = "Cloudflare zone activation status"
  value       = local.zone_status
}

output "console_custom_domain" {
  description = "Console custom domain hostname"
  value       = local.console_custom_domain
}

output "worker_name" {
  description = "Worker service name bound to the custom domain"
  value       = local.worker_name
}

output "worker_custom_domain_id" {
  description = "ID of the console worker custom domain (if configured)"
  value       = local.has_custom_domain ? cloudflare_workers_domain.console[0].id : "not_configured"
}
