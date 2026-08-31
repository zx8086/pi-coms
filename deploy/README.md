# Deploying coms-net: one hub, one agent per environment

Star topology. The hub is a zero-permission relay on the VPS; each environment
(AWS account, VPS, laptop) runs its own Pi agent that registers with the hub by
name. From your laptop you address any environment's agent directly:

```
laptop pi ──────────┐
aws-111111111111 ───┼──▶ hub (coms.siobytes.cloud, no AWS permissions)
aws-222222222222 ───┤
devops (VPS) ───────┘
```

The hub never touches any account. The agent inside each AWS account carries an
instance role (ViewOnlyAccess by default) and answers questions about that
account only. If the hub's own account needs visibility, it gets a spoke agent
like every other account.

## Layout

| Path | What it is |
|---|---|
| `bootstrap/agent-bootstrap.sh` | Shared agent bootstrap. All real install/launch logic; parameterized by `SECRETS_SOURCE=aws\|file`. Installs `pi-agent.service` and `pi-monitor.service`. |
| `hub/Dockerfile` | The hub container. Runs anywhere with Docker; needs only `PI_COMS_NET_AUTH_TOKEN` and a public URL. Mounts a volume for the sqlite mailbox. |
| `hostinger/` | The live hub (`docker-compose.yml` behind Traefik) plus the VPS agent shim. |
| `modules/agent/` | Terraform module: one Pi agent in one AWS account. IAM role, EC2 host, secrets, userdata shim. |
| `accounts/<name>/` | One root per AWS account. Copy `accounts/eu-oit-dev`, set the profile, apply. |

## Adding an AWS account

1. Copy `accounts/eu-oit-dev` to `accounts/<name>`.
2. Create `terraform.tfvars` (gitignored) with the account's `aws_profile`,
   `region`, `repo_url` (this repo's clone URL, reachable from the instance),
   and `coms_auth_token` (the hub's token; sourcing notes in
   `accounts/eu-oit-dev/main.tf`).
3. `terraform init && terraform apply`.
4. Populate the provider-keys secret the output names, then reboot the
   instance:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id pi-agent/agent-provider-keys \
     --secret-string '{"OPENAI_API_KEY":"sk-..."}' --profile <name>
   aws ec2 reboot-instances --instance-ids <id> --profile <name>
   ```
5. From your laptop: `just coms --name me --cname me`, then `coms_net_list`
   shows the new agent (default name `aws-<account_id>`). The host also runs
   `monitor-aws-<account_id>` (registered `--explicit`, so it is hidden from
   lists unless named): scheduled alarm/log/drift/cost checks whose reports
   reach `laptop` through the hub mailbox even while you are offline. See
   `docs/architecture/monitoring.md`.

Notes:

- The instance clones `repo_url` at boot (the repo's default branch), so
  changes must be merged to `main` before an apply, reboot, or bootstrap
  re-run picks them up. To update a live host, re-run the bootstrap over SSM:
  `aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript
  --parameters 'commands=["bash /var/lib/cloud/instance/user-data.txt"]'`.
- Every agent shares one bearer token and one coms project; account isolation
  comes from names and IAM, not the namespace.
- State is local and per-account under `accounts/<name>/`; it contains the
  token, and it is gitignored along with tfvars.
- The host sits in the default VPC with a public IP (egress only, no inbound
  rules, no NAT cost). Shell access is SSM Session Manager; see the
  `attach_to_agent` output.
