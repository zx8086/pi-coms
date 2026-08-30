# deploy/modules/agent/variables.tf

variable "hub_url" {
  description = "coms-net hub base URL the agent registers with, e.g. https://coms.siobytes.cloud."
  type        = string
}

variable "coms_auth_token" {
  description = "Shared bearer token for the hub. Same value the hub runs with; stored in this account's Secrets Manager so the instance fetches it at boot via its role."
  type        = string
  sensitive   = true
}

variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
  default     = "pi-agent"
}

variable "agent_name" {
  description = "coms-net --cname. Peers address this account's agent by this name. Empty string derives aws-<account_id>."
  type        = string
  default     = ""
}

variable "agent_purpose" {
  description = "Purpose string advertised to peers via coms_net_list. Empty string derives one from the account id and region."
  type        = string
  default     = ""
}

variable "coms_project" {
  description = "coms-net project namespace. Keep all accounts in one project so the laptop sees every agent; names distinguish accounts."
  type        = string
  default     = "default"
}

variable "pi_model" {
  description = "Model the agent runs, provider-qualified (a bare id can fuzzy-match the wrong provider). Passed to pi as --model."
  type        = string
  default     = "openai/gpt-5.4-mini"
}

variable "instance_type" {
  description = "Instance type for the agent host. Must be Graviton (arm64); the AMI is AL2023 arm64."
  type        = string
  default     = "t4g.small"
}

variable "subnet_id" {
  description = "Subnet for the agent host. Empty string uses the default VPC's first default subnet. The host gets a public IP for egress (hub, installs) instead of a NAT gateway; its security group allows no inbound."
  type        = string
  default     = ""
}

variable "ssh_public_key" {
  description = "Public key authorized for the piagent user, enabling `herdr --remote` over the SSM tunnel (no inbound port). Empty string disables SSH login, leaving `aws ssm start-session` as the only way in."
  type        = string
  default     = ""
}

variable "repo_url" {
  description = "Git clone URL of this repo; the host clones it at boot for the extension code and bootstrap script."
  type        = string
}
