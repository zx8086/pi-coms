// deploy/modules/agent/main.tf
//
// One Pi coms-net agent for one AWS account: EC2 host + instance role. Apply
// this module once per account (see deploy/accounts/); the hub lives elsewhere
// and holds no AWS permissions. The agent registers with the hub by name and
// answers questions about the account its role can see.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id    = data.aws_caller_identity.current.account_id
  region        = data.aws_region.current.name
  agent_name    = var.agent_name != "" ? var.agent_name : "aws-${local.account_id}"
  agent_purpose = var.agent_purpose != "" ? var.agent_purpose : "Read-only AWS devops agent for account ${local.account_id} (${local.region})"
}

// ── Network placement ──────────────────────────────────────────────────────
// Default VPC public subnet with a public IP: outbound-only reachability with
// no NAT gateway to pay for. The security group has no ingress; SSM Session
// Manager is the only way in.

data "aws_vpc" "default" {
  count   = var.subnet_id == "" ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.subnet_id == "" ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }
}

data "aws_subnet" "chosen" {
  id = var.subnet_id != "" ? var.subnet_id : data.aws_subnets.default[0].ids[0]
}

resource "aws_security_group" "agent" {
  name        = "${var.name_prefix}-agent"
  description = "Pi agent host: no inbound, all outbound"
  vpc_id      = data.aws_subnet.chosen.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-agent" }
}

// ── Secrets ────────────────────────────────────────────────────────────────
// SSM Parameter Store SecureStrings (standard tier: free; decrypted through
// the AWS-managed aws/ssm key, so ssm:GetParameter alone suffices). Each
// account stores its own copy of the shared hub token, so the stack is
// self-contained and needs no cross-account policy.

resource "aws_ssm_parameter" "coms_token" {
  name        = "/${var.name_prefix}/auth-token"
  description = "Bearer token for the coms-net hub (copy of the hub's token)"
  type        = "SecureString"
  value       = var.coms_auth_token
}

// Created as a placeholder. Populate out of band so keys never land in
// state or tfvars:
//   aws ssm put-parameter --name /<name_prefix>/agent-provider-keys \
//     --type SecureString --overwrite \
//     --value '{"OPENAI_API_KEY":"sk-..."}'
resource "aws_ssm_parameter" "provider_keys" {
  name        = "/${var.name_prefix}/agent-provider-keys"
  description = "Model provider API keys for the Pi agent (populate manually)"
  type        = "SecureString"
  value       = "{}"

  lifecycle {
    ignore_changes = [value]
  }
}

// ── Instance role ──────────────────────────────────────────────────────────

resource "aws_iam_role" "agent" {
  name = "${var.name_prefix}-agent"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

// ViewOnlyAccess, not ReadOnlyAccess: the agent describes the environment.
// ViewOnlyAccess is metadata-only -- no s3:GetObject, no DynamoDB item reads,
// no secret values -- which is the right floor for an agent sitting in a prod
// account. Widen deliberately, one named action at a time.
resource "aws_iam_role_policy_attachment" "agent_viewonly" {
  role       = aws_iam_role.agent.name
  policy_arn = "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"
}

// ViewOnlyAccess covers cloudwatch:Get*/List* and logs:Describe* but not
// cloudwatch:Describe* or log-content reads, so the agent cannot answer
// "which alarms are firing" or read log events. These are the named widenings
// the comment above calls for: still read-only, but data-plane reads on logs.
resource "aws_iam_role_policy" "agent_cloudwatch_read" {
  name = "cloudwatch-logs-read"
  role = aws_iam_role.agent.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cloudwatch:DescribeAlarms",
        "cloudwatch:DescribeAlarmHistory",
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:StartQuery",
        "logs:GetQueryResults",
      ]
      Resource = "*"
    }]
  })
}

// The monitor's daily cost check. Cost Explorer has no resource-level scoping.
resource "aws_iam_role_policy" "agent_cost_read" {
  name = "cost-explorer-read"
  role = aws_iam_role.agent.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ce:GetCostAndUsage"]
      Resource = "*"
    }]
  })
}

// Claude via Bedrock under the instance role: no provider API keys anywhere.
// Cross-region inference profiles need invoke on both the profile and the
// underlying foundation models in the destination regions.
resource "aws_iam_role_policy" "agent_bedrock_invoke" {
  count = var.enable_bedrock ? 1 : 0
  name  = "bedrock-invoke-anthropic"
  role  = aws_iam_role.agent.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
      ]
      Resource = [
        "arn:aws:bedrock:*::foundation-model/anthropic.*",
        "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/eu.anthropic.*",
      ]
    }]
  })
}

// SSM Session Manager: shell access with no inbound port and no SSH key.
resource "aws_iam_role_policy_attachment" "agent_ssm" {
  role       = aws_iam_role.agent.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

// The data-plane reads the host itself needs: its two boot parameters, and
// (when configured) the fleet bundle in the distribution bucket.
resource "aws_iam_role_policy" "agent_secrets" {
  name = "read-agent-parameters"
  role = aws_iam_role.agent.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          aws_ssm_parameter.coms_token.arn,
          aws_ssm_parameter.provider_keys.arn,
        ]
      }],
      var.dist_bucket_arn == "" ? [] : [{
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [var.dist_bucket_arn, "${var.dist_bucket_arn}/*"]
      }]
    )
  })
}

resource "aws_iam_instance_profile" "agent" {
  name = "${var.name_prefix}-agent"
  role = aws_iam_role.agent.name
}

// ── Host ───────────────────────────────────────────────────────────────────

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64"
}

resource "aws_instance" "agent" {
  ami                         = data.aws_ssm_parameter.al2023_arm64.value
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnet.chosen.id
  vpc_security_group_ids      = [aws_security_group.agent.id]
  iam_instance_profile        = aws_iam_instance_profile.agent.name
  associate_public_ip_address = var.associate_public_ip

  user_data_replace_on_change = true

  user_data = templatefile("${path.module}/userdata.sh.tftpl", {
    hub_url          = var.hub_url
    token_param_name = aws_ssm_parameter.coms_token.name
    keys_param_name  = aws_ssm_parameter.provider_keys.name
    region           = local.region
    account_id       = local.account_id
    agent_name       = local.agent_name
    agent_purpose    = local.agent_purpose
    coms_project     = var.coms_project
    pi_model         = var.pi_model
    pi_provider      = var.pi_provider
    ssh_public_key   = var.ssh_public_key
    repo_url         = var.repo_url
    bundle_s3_uri    = var.bundle_s3_uri
  })

  metadata_options {
    http_tokens   = "required" // IMDSv2 only
    http_endpoint = "enabled"
  }

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }

  tags = { Name = "${var.name_prefix}-agent" }

  depends_on = [aws_ssm_parameter.coms_token]
}

// Status-check alarm on the agent host itself: gives the monitor's alarm
// family a real signal for the one instance that must stay healthy. No alarm
// actions -- the monitor's DescribeAlarms sweep picks up the transition and
// reports it. Missing data (host stopped) stays quiet; the drift check
// already covers stops.
resource "aws_cloudwatch_metric_alarm" "agent_status_check" {
  alarm_name          = "${var.name_prefix}-agent-status-check"
  alarm_description   = "EC2 status checks failing on the Pi agent host"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = aws_instance.agent.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}
