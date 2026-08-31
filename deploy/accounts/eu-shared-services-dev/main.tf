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
  description = "Provider-qualified model for the agent."
  type        = string
  default     = "openai/gpt-5.4-mini"
}

module "hub" {
  source = "../../modules/hub"

  coms_auth_token = var.coms_auth_token
  subnet_id       = var.hub_subnet_id
  allowed_cidrs   = var.allowed_cidrs
  repo_url        = var.repo_url
}

module "agent" {
  source = "../../modules/agent"

  hub_url             = module.hub.hub_url
  coms_auth_token     = var.coms_auth_token
  repo_url            = var.repo_url
  subnet_id           = var.agent_subnet_id
  associate_public_ip = false
  instance_type       = "t4g.micro"
  pi_model            = var.pi_model

  depends_on = [module.hub]
}

output "hub_url" {
  value = module.hub.hub_url
}

output "hub_instance_id" {
  value = module.hub.hub_instance_id
}

output "token_secret_arn" {
  value = module.hub.token_secret_arn
}

output "agent_name" {
  value = module.agent.agent_name
}

output "agent_instance_id" {
  value = module.agent.agent_instance_id
}

output "provider_keys_secret_name" {
  value = module.agent.provider_keys_secret_name
}

output "attach_to_hub" {
  value = module.hub.attach_to_hub
}

output "attach_to_agent" {
  value = module.agent.attach_to_agent
}
