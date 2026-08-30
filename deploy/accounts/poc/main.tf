// deploy/accounts/poc/main.tf
//
// First spoke: one Pi agent in one AWS account, registering with the VPS hub.
// To add another account, copy this directory, change the profile (and
// optionally agent_name), and apply. State stays local and per-account.
//
// The hub token lives on the VPS. Fetch it once and pass it as a variable:
//   ssh root@server.siobytes.cloud \
//     "grep '^PI_COMS_NET_AUTH_TOKEN=' /root/.secrets/server-siobytes-cloud/coms-net-hub.env" \
//     | cut -d= -f2- | xargs -I{} echo 'coms_auth_token = "{}"' >> terraform.tfvars

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
      Stack     = "agent-poc"
    }
  }
}

variable "region" {
  description = "AWS region for the agent host."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Local AWS CLI profile for this account."
  type        = string
  default     = "default"
}

variable "coms_auth_token" {
  description = "Bearer token of the VPS hub (see header comment)."
  type        = string
  sensitive   = true
}

variable "repo_url" {
  description = "Git clone URL of this repo, reachable from the instance at boot."
  type        = string
}

variable "agent_name" {
  description = "coms-net name for this account's agent. Empty derives aws-<account_id>."
  type        = string
  default     = ""
}

variable "ssh_public_key" {
  description = "Optional public key for herdr --remote over the SSM tunnel."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "Subnet for the agent host. Empty uses the default VPC's first default subnet, which may sit in an AZ without the instance type."
  type        = string
  default     = ""
}

module "agent" {
  source = "../../modules/agent"

  hub_url         = "https://coms.siobytes.cloud"
  coms_auth_token = var.coms_auth_token
  repo_url        = var.repo_url
  agent_name      = var.agent_name
  ssh_public_key  = var.ssh_public_key
  subnet_id       = var.subnet_id
}

output "agent_name" {
  value = module.agent.agent_name
}

output "account_id" {
  value = module.agent.account_id
}

output "agent_instance_id" {
  value = module.agent.agent_instance_id
}

output "agent_role_arn" {
  value = module.agent.agent_role_arn
}

output "provider_keys_secret_name" {
  value = module.agent.provider_keys_secret_name
}

output "attach_to_agent" {
  value = module.agent.attach_to_agent
}
