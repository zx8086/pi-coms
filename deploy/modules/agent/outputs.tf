# deploy/modules/agent/outputs.tf

output "agent_name" {
  description = "coms-net name this account's agent registers under. Address it with coms_net_send target."
  value       = local.agent_name
}

output "account_id" {
  description = "AWS account the agent describes."
  value       = local.account_id
}

output "agent_instance_id" {
  description = "EC2 instance ID of the agent host."
  value       = aws_instance.agent.id
}

output "agent_role_arn" {
  description = "Instance role of the agent host (host plumbing in readonly mode)."
  value       = aws_iam_role.agent.arn
}

output "devops_readonly_role_arn" {
  description = "DevOpsAgentReadOnly role the workload assumes for AWS reads (empty when readonly_role = false)."
  value       = var.readonly_role ? aws_iam_role.devops_readonly[0].arn : ""
}

output "provider_keys_parameter_name" {
  description = "Populate this SecureString parameter with model provider API keys (aws ssm put-parameter --overwrite), then re-run the bootstrap or reboot."
  value       = aws_ssm_parameter.provider_keys.name
}

output "attach_to_agent" {
  description = "Open a shell on the agent host, then attach its live Pi TUI."
  value       = <<-EOT
    aws ssm start-session --target ${aws_instance.agent.id} --region ${local.region}
    # then, on the host:
    sudo -u piagent -i herdr
  EOT
}
