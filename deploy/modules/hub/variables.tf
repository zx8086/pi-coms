# deploy/modules/hub/variables.tf

variable "coms_auth_token" {
  description = "Shared bearer token every client presents. Stored as an SSM SecureString parameter in this account; the host fetches it at boot via its role."
  type        = string
  sensitive   = true
}

variable "bundle_s3_uri" {
  description = "S3 URI of the fleet-bundle prefix. When set, the host fetches code from the bundle instead of cloning repo_url. Empty keeps the git path."
  type        = string
  default     = ""
}

variable "dist_bucket_arn" {
  description = "ARN of the distribution bucket backing bundle_s3_uri; grants the instance read access. Required when bundle_s3_uri is set."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "Subnet for the hub host. Use a private subnet behind a NAT gateway; clients reach the hub over private routing (VPC peering / Transit Gateway)."
  type        = string
}

variable "allowed_cidrs" {
  description = "CIDR blocks allowed to reach the hub port (client VPCs, VPN ranges). Keep this as narrow as the fleet allows."
  type        = list(string)
}

variable "repo_url" {
  description = "Git clone URL of this repo; the host clones it at boot for the server script."
  type        = string
}

variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
  default     = "pi-coms-hub"
}

variable "instance_type" {
  description = "Instance type for the hub host. Must be Graviton (arm64); the AMI is AL2023 arm64. The hub is a single small Bun process."
  type        = string
  default     = "t4g.micro"
}

variable "port" {
  description = "TCP port the hub listens on."
  type        = number
  default     = 8787
}

variable "associate_public_ip" {
  description = "Give the host a public IP. Leave false for the intended private-subnet placement."
  type        = bool
  default     = false
}
