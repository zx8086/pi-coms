# deploy/modules/hub/outputs.tf

output "hub_url" {
  description = "Base URL clients and agents use (private IP; requires routing from their VPC)."
  value       = "http://${aws_instance.hub.private_ip}:${var.port}"
}

output "hub_instance_id" {
  description = "EC2 instance ID of the hub host."
  value       = aws_instance.hub.id
}

output "hub_private_ip" {
  description = "Private IP of the hub host."
  value       = aws_instance.hub.private_ip
}

output "token_secret_arn" {
  description = "Secrets Manager ARN holding the hub token in this account."
  value       = aws_secretsmanager_secret.coms_token.arn
}

output "attach_to_hub" {
  description = "Open a shell on the hub host."
  value       = "aws ssm start-session --target ${aws_instance.hub.id} --region ${data.aws_region.current.name}"
}
