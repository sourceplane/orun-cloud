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
  }
}

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

# --- Variables ---

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
  default = "dev"
}

variable "component" {
  type    = string
  default = "bootstrap"
}

variable "stackName" {
  type    = string
  default = "bootstrap"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# --- Data sources to verify access ---

data "aws_caller_identity" "current" {}

data "aws_s3_bucket" "state" {
  bucket = "${var.orgName}-${var.environment}"
}

# --- Outputs ---

output "account_id" {
  description = "AWS account ID confirming role assumption"
  value       = data.aws_caller_identity.current.account_id
}

output "state_bucket_arn" {
  description = "ARN of the S3 state bucket confirming access"
  value       = data.aws_s3_bucket.state.arn
}
