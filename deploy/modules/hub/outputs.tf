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

output "token_parameter_name" {
  description = "SSM SecureString parameter holding the hub token in this account."
  value       = aws_ssm_parameter.coms_token.name
}

output "attach_to_hub" {
  description = "Open a shell on the hub host."
  value       = "aws ssm start-session --target ${aws_instance.hub.id} --region ${data.aws_region.current.name}"
}
