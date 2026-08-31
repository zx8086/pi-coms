// deploy/accounts/eu-shared-services-dev/main.tf
//
// Corporate dev deployment, hub account: the private in-VPC hub plus this
// account's own agent, in one apply. Spoke accounts (see
// deploy/accounts/eu-oit-dev/) run only the agent module and point hub_url
// at this hub's private IP over the Transit Gateway.
//
// The hub boots in parallel with the agent and takes a minute to come up;
// the agent's launch script polls the hub for ~60s. If the agent host wins
// the race on first apply, restart it once:
//   aws ssm send-command --instance-ids <agent-id> \
//     --document-name AWS-RunShellScript \
//     --parameters 'commands=["systemctl restart pi-agent pi-monitor"]'
//
// Generate the fleet token once and keep it in terraform.tfvars (gitignored):
//   echo "coms_auth_token = \"$(openssl rand -hex 32)\"" >> terraform.tfvars

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = "pi-coms-net"
      ManagedBy = "terraform"
      Stack     = "shared-services-dev"
    }
  }
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-central-1"
}

variable "aws_profile" {
  description = "Local AWS CLI profile for this account."
  type        = string
  default     = "eu-shared-services-dev"
}

variable "coms_auth_token" {
  description = "Fleet-wide bearer token (see header comment)."
  type        = string
  sensitive   = true
}

variable "repo_url" {
  description = "Git clone URL of this repo, reachable from the instances at boot."
  type        = string
}

variable "hub_subnet_id" {
  description = "Private subnet for the hub host."
  type        = string
}

variable "agent_subnet_id" {
  description = "Private subnet for this account's agent host."
  type        = string
}

variable "allowed_cidrs" {
  description = "CIDRs allowed to reach the hub port: client VPCs and VPN ranges. e.g. [\"10.34.88.0/23\", \"10.35.0.0/24\"]."
  type        = list(string)
}

variable "pi_model" {
  description = "Bedrock inference-profile id the agent runs. EU profiles keep inference inside EU regions."
  type        = string
  default     = "eu.anthropic.claude-sonnet-5"
}

variable "agent_name" {
  description = "coms-net name for this account's agent. Account-and-environment names read better than account ids in a fleet; the monitor pairs itself as monitor-<agent_name>."
  type        = string
  default     = "eu-shared-services-dev"
}

variable "org_id" {
  description = "AWS Organizations id (o-...). Scopes distribution-bucket reads to principals inside the org, so spoke-account agent roles can fetch the bundle without per-role policy churn."
  type        = string
}

// ── Fleet distribution bucket ──────────────────────────────────────────────
// AWS-native code channel: hosts fetch the bundle from here instead of
// cloning GitHub. Publish with deploy/publish-fleet.sh; rollback by
// re-pointing the version object at a previous S3 object version.

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "dist" {
  bucket = "pi-coms-dist-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "dist" {
  bucket = aws_s3_bucket.dist.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "dist" {
  bucket                  = aws_s3_bucket.dist.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "dist_org_read" {
  bucket = aws_s3_bucket.dist.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "OrgRead"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject", "s3:ListBucket"]
      Resource  = [aws_s3_bucket.dist.arn, "${aws_s3_bucket.dist.arn}/*"]
      Condition = { StringEquals = { "aws:PrincipalOrgID" = var.org_id } }
    }]
  })
}

locals {
  bundle_s3_uri = "s3://${aws_s3_bucket.dist.bucket}/fleet"
}

// Directory mode from day one: per-principal tokens under /pi-coms/auth.
// Create principals with `just token-create <name> <names-csv> <kind>
// eu-shared-services-dev`; the shared coms_auth_token stays valid as the
// root/migration principal. To move an agent onto its own token, create its
// principal here and put the same value into the agent account's auth-token
// parameter, then re-run its bootstrap.
module "hub" {
  source = "../../modules/hub"

  coms_auth_token = var.coms_auth_token
  subnet_id       = var.hub_subnet_id
  allowed_cidrs   = var.allowed_cidrs
  repo_url        = var.repo_url
  bundle_s3_uri   = local.bundle_s3_uri
  dist_bucket_arn = aws_s3_bucket.dist.arn
  auth_ssm_path   = "/pi-coms/auth"
}

module "agent" {
  source = "../../modules/agent"

  hub_url             = module.hub.hub_url
  coms_auth_token     = var.coms_auth_token
  repo_url            = var.repo_url
  agent_name          = var.agent_name
  subnet_id           = var.agent_subnet_id
  associate_public_ip = false
  instance_type       = "t4g.small" # 1 GB OOM-killed the agent mid-investigation; 2 GB + swap
  pi_model            = var.pi_model
  pi_provider         = "amazon-bedrock"
  enable_bedrock      = true
  readonly_role       = true
  bundle_s3_uri       = local.bundle_s3_uri
  dist_bucket_arn     = aws_s3_bucket.dist.arn

  depends_on = [module.hub]
}

// ── Convergence ────────────────────────────────────────────────────────────
// Every 30 minutes each tagged host compares its bundle version against S3
// and re-bootstraps on change. Immediate rollout: run the same command via
// `aws ssm send-command --targets Key=tag:Project,Values=pi-coms-net`.

resource "aws_ssm_association" "fleet_update" {
  name             = "AWS-RunShellScript"
  association_name = "pi-coms-fleet-update"

  targets {
    key    = "tag:Project"
    values = ["pi-coms-net"]
  }

  schedule_expression = "rate(30 minutes)"

  parameters = {
    commands = "[ -x /usr/local/bin/pi-coms-update ] && /usr/local/bin/pi-coms-update || true"
  }
}

output "hub_url" {
  value = module.hub.hub_url
}

output "hub_instance_id" {
  value = module.hub.hub_instance_id
}

output "token_parameter_name" {
  value = module.hub.token_parameter_name
}

output "dist_bucket" {
  value = aws_s3_bucket.dist.bucket
}

output "agent_name" {
  value = module.agent.agent_name
}

output "agent_instance_id" {
  value = module.agent.agent_instance_id
}

output "provider_keys_parameter_name" {
  value = module.agent.provider_keys_parameter_name
}

output "attach_to_hub" {
  value = module.hub.attach_to_hub
}

output "attach_to_agent" {
  value = module.agent.attach_to_agent
}
