# deploy/modules/agent/variables.tf

variable "hub_url" {
  description = "coms-net hub base URL the agent registers with, e.g. https://coms.siobytes.cloud."
  type        = string
}

variable "coms_auth_token" {
  description = "Shared bearer token for the hub. Same value the hub runs with; stored as an SSM SecureString parameter in this account so the instance fetches it at boot via its role."
  type        = string
  sensitive   = true
}

variable "bundle_s3_uri" {
  description = "S3 URI of the fleet-bundle prefix (e.g. s3://pi-coms-dist/fleet). When set, the host fetches code from the bundle instead of cloning repo_url, and installs the pi-coms-update convergence script. Empty keeps the git path."
  type        = string
  default     = ""
}

variable "dist_bucket_arn" {
  description = "ARN of the distribution bucket backing bundle_s3_uri; grants the instance read access. Required when bundle_s3_uri is set."
  type        = string
  default     = ""
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
  description = "Model the agent runs, provider-qualified (a bare id can fuzzy-match the wrong provider). Passed to pi as --model. With pi_provider = amazon-bedrock, use a Bedrock inference-profile id, e.g. eu.anthropic.claude-sonnet-5."
  type        = string
  default     = "openai/gpt-5.4-mini"
}

variable "pi_provider" {
  description = "Explicit pi provider (--provider). Set to amazon-bedrock to run models through Bedrock under the instance role (no API keys; pair with enable_bedrock). Empty lets pi resolve the provider from the model id."
  type        = string
  default     = ""
}

variable "readonly_role" {
  description = "Create the account's DevOpsAgentReadOnly role (mirroring the prod incident-analyzer role and policies, vendored in policies/) and route all agent/monitor AWS reads through it via same-account AssumeRole. The instance role slims to host plumbing (SSM, parameters, S3 bundle, Bedrock). False keeps the legacy ViewOnlyAccess-on-instance-role model."
  type        = bool
  default     = false
}

variable "readonly_external_id" {
  description = "ExternalId required to assume DevOpsAgentReadOnly (prod uses devops-agent-prod-access)."
  type        = string
  default     = "devops-agent-dev-access"
}

variable "readonly_extra_trusted_arns" {
  description = "Additional principals allowed to assume DevOpsAgentReadOnly, e.g. the prod DevOpsAgentCoreRole if the incident analyzer later monitors this account."
  type        = list(string)
  default     = []
}

variable "enable_bedrock" {
  description = "Grant the instance role bedrock:InvokeModel(+WithResponseStream) on Anthropic foundation models and this account's eu.anthropic.* inference profiles."
  type        = bool
  default     = false
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

variable "associate_public_ip" {
  description = "Give the host a public IP for egress (no-NAT default-VPC pattern). Set false when subnet_id is a private subnet behind a NAT gateway; a public IP there is useless and often policy-violating."
  type        = bool
  default     = true
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
