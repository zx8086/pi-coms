// deploy/accounts/eu-oit-dev/main.tf
//
// Corporate dev deployment, OIT spoke: agent + monitor only, registering with
// the shared-services hub over the Transit Gateway. Creates this account's
// DevOpsAgentReadOnly (readonly_role) and its own State Manager association
// for fleet-bundle convergence; the bundle and hub live in shared-services.
//
// coms_auth_token: same fleet token the hub runs with (see the
// eu-shared-services-dev root); keep it in gitignored terraform.tfvars.

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
      Stack     = "oit-dev"
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
  default     = "eu-oit-dev"
}

variable "coms_auth_token" {
  description = "Fleet-wide bearer token (the hub's root token)."
  type        = string
  sensitive   = true
}

variable "repo_url" {
  description = "Git clone URL of this repo (unused in bundle mode, kept for the module contract)."
  type        = string
  default     = "https://github.com/zx8086/pi-coms.git"
}

variable "hub_url" {
  description = "Private URL of the shared-services hub, reached over the TGW."
  type        = string
  default     = "http://10.34.89.51:8787"
}

variable "agent_subnet_id" {
  description = "Private subnet for the agent host."
  type        = string
  default     = "subnet-0aff97830c4f4ac47"
}

variable "dist_bucket" {
  description = "Fleet distribution bucket in shared-services (org-scoped read)."
  type        = string
  default     = "pi-coms-dist-352896877281"
}

variable "pi_model" {
  description = "Bedrock inference-profile id the agent runs."
  type        = string
  default     = "eu.anthropic.claude-sonnet-5"
}

variable "agent_name" {
  description = "coms-net name for this account's agent; the monitor pairs as monitor-<agent_name>."
  type        = string
  default     = "eu-oit-dev"
}

module "agent" {
  source = "../../modules/agent"

  hub_url             = var.hub_url
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
  bundle_s3_uri       = "s3://${var.dist_bucket}/fleet"
  dist_bucket_arn     = "arn:aws:s3:::${var.dist_bucket}"
}

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

output "agent_name" {
  value = module.agent.agent_name
}

output "agent_instance_id" {
  value = module.agent.agent_instance_id
}

output "devops_readonly_role_arn" {
  value = module.agent.devops_readonly_role_arn
}

output "provider_keys_parameter_name" {
  value = module.agent.provider_keys_parameter_name
}

output "attach_to_agent" {
  value = module.agent.attach_to_agent
}
