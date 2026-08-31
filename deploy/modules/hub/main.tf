// deploy/modules/hub/main.tf
//
// The coms-net hub as a private AWS service: one small EC2 host running
// scripts/coms-net-server.ts under systemd, reachable only from the CIDRs
// you allow (over VPC peering / Transit Gateway). This is the in-VPC
// alternative to the VPS deployment (deploy/hostinger/) -- no public
// exposure, no TLS proxy; the bearer token and network placement are the
// perimeter. The hub holds no cloud permissions beyond reading its own
// token secret; the mailbox persists on the root EBS volume.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_subnet" "chosen" {
  id = var.subnet_id
}

locals {
  region = data.aws_region.current.name
}

// ── Network ────────────────────────────────────────────────────────────────

resource "aws_security_group" "hub" {
  name        = "${var.name_prefix}-hub"
  description = "coms-net hub: inbound hub port from allowed CIDRs only"
  vpc_id      = data.aws_subnet.chosen.vpc_id

  ingress {
    description = "coms-net clients"
    from_port   = var.port
    to_port     = var.port
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-hub" }
}

// ── Secrets ────────────────────────────────────────────────────────────────

resource "aws_secretsmanager_secret" "coms_token" {
  name                    = "${var.name_prefix}/auth-token"
  description             = "Bearer token the hub runs with (agents store their own per-account copy)"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "coms_token" {
  secret_id     = aws_secretsmanager_secret.coms_token.id
  secret_string = var.coms_auth_token
}

// ── Instance role ──────────────────────────────────────────────────────────
// Deliberately minimal: the hub is a zero-permission relay. SSM for shell
// access, plus the one read it needs at boot -- its own token.

resource "aws_iam_role" "hub" {
  name = "${var.name_prefix}-hub"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "hub_ssm" {
  role       = aws_iam_role.hub.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "hub_secret" {
  name = "read-hub-token"
  role = aws_iam_role.hub.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.coms_token.arn]
    }]
  })
}

resource "aws_iam_instance_profile" "hub" {
  name = "${var.name_prefix}-hub"
  role = aws_iam_role.hub.name
}

// ── Host ───────────────────────────────────────────────────────────────────

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64"
}

resource "aws_instance" "hub" {
  ami                         = data.aws_ssm_parameter.al2023_arm64.value
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnet.chosen.id
  vpc_security_group_ids      = [aws_security_group.hub.id]
  iam_instance_profile        = aws_iam_instance_profile.hub.name
  associate_public_ip_address = var.associate_public_ip

  user_data_replace_on_change = true

  user_data = templatefile("${path.module}/userdata.sh.tftpl", {
    token_secret_arn = aws_secretsmanager_secret.coms_token.arn
    region           = local.region
    repo_url         = var.repo_url
    port             = var.port
  })

  metadata_options {
    http_tokens   = "required" // IMDSv2 only
    http_endpoint = "enabled"
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  tags = { Name = "${var.name_prefix}-hub" }

  depends_on = [aws_secretsmanager_secret_version.coms_token]
}
