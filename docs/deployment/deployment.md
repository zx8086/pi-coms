# Deployment

Deploys the pi-coms star topology: one zero-permission hub on the Hostinger VPS and one read-only Pi agent per AWS account. The hub relays messages; every agent registers with it by name over outbound HTTPS.

```
laptop pi ──────────┐
aws-356994971776 ───┼──▶ hub (coms.siobytes.cloud)
devops (VPS) ───────┘
```

> For the networking and trust model behind these choices, see
> [networking.md](../architecture/networking.md) and
> [security-model.md](../security/security-model.md).

## Components

| Component | Where it runs | Source |
|-----------|---------------|--------|
| Hub | Docker on the VPS, behind Traefik | `deploy/hub/Dockerfile`, `deploy/hostinger/docker-compose.yml` |
| VPS agent (`devops`) | systemd on the VPS | `deploy/hostinger/bootstrap-agent.sh` |
| AWS agent (one per account) | EC2 via Terraform | `deploy/modules/agent/`, `deploy/accounts/<name>/` |
| Shared bootstrap | Both agent hosts | `deploy/bootstrap/agent-bootstrap.sh` |

All install and launch logic lives in the shared bootstrap. The AWS userdata shim (`deploy/modules/agent/userdata.sh.tftpl`) and the VPS shim (`deploy/hostinger/bootstrap-agent.sh`) only set the environment contract documented at the top of `deploy/bootstrap/agent-bootstrap.sh:12-34` and hand off.

---

## Hub on the VPS

The hub is a single Bun container built from `deploy/hub/Dockerfile`. The server script is self-contained, so the image has no install step. It binds to `127.0.0.1:8787` on the host; Traefik (running with `network_mode: host`) terminates TLS for `coms.siobytes.cloud` with the existing `*.siobytes.cloud` wildcard certificate and proxies to loopback.

Deploy or update:

```bash
# On the VPS. /srv/pi-coms holds copies of deploy/ and scripts/ from this repo.
cd /srv/pi-coms/deploy/hostinger && docker compose up -d --build
```

One-time setup on a fresh VPS:

```bash
# 1. Hub token
openssl rand -hex 32 | sed 's/^/PI_COMS_NET_AUTH_TOKEN=/' \
  > /root/.secrets/server-siobytes-cloud/coms-net-hub.env
chmod 600 /root/.secrets/server-siobytes-cloud/coms-net-hub.env

# 2. Hub container
cd /srv/pi-coms/deploy/hostinger && docker compose up -d --build

# 3. Traefik route: merge deploy/hostinger/traefik-router.yml into
#    /srv/traefik/dynamic/routers.yml (Traefik watches the directory).

# 4. VPS agent
REPO_URL=https://github.com/zx8086/pi-coms.git \
  bash /srv/pi-coms/deploy/hostinger/bootstrap-agent.sh
```

Operating notes:

1. **Do not scale past one replica.** The registry and Server-Sent Events (SSE) connections live in process memory; a second container splits the registry.
2. **Restarting the hub clears the registry.** Agents re-register on their next heartbeat (10 seconds).
3. The healthcheck polls `http://127.0.0.1:8787/health` every 30 seconds (`deploy/hostinger/docker-compose.yml:39-44`).

---

## AWS agent per account

`deploy/modules/agent/` is applied once per AWS account from a root under `deploy/accounts/`. It creates an EC2 host (Graviton, AL2023 arm64), an instance role, and two Secrets Manager secrets. The instance clones `repo_url` at boot and runs the shared bootstrap, so deployment changes must be pushed before an apply or reboot picks them up.

### Adding an account

1. Copy `deploy/accounts/poc` to `deploy/accounts/<name>`.
2. Create `terraform.tfvars` (gitignored):

```hcl
aws_profile     = "<cli-profile>"
repo_url        = "https://github.com/zx8086/pi-coms.git"
coms_auth_token = "<hub token>"        # fetch command in accounts/poc/main.tf
ssh_public_key  = "ssh-ed25519 ..."    # optional, enables herdr --remote
subnet_id       = "subnet-..."         # optional, see Placement below
instance_type   = "t4g.micro"          # optional, default t4g.small
```

3. `terraform init && terraform apply`.
4. Populate the provider-keys secret and reboot is **not** enough on first boot (see Gotchas). For an already-bootstrapped host:

```bash
aws secretsmanager put-secret-value \
  --secret-id pi-agent/agent-provider-keys \
  --secret-string '{"OPENAI_API_KEY":"sk-..."}' --profile <name>
aws ec2 reboot-instances --instance-ids <id> --profile <name>
```

5. The agent appears in `coms_net_list` as `aws-<account_id>`.

### What the module creates

| Resource | Purpose |
|----------|---------|
| `aws_instance.agent` | t4g host, public IP, egress-only security group |
| `aws_iam_role.agent` | `ViewOnlyAccess` + `AmazonSSMManagedInstanceCore` + inline policies |
| `aws_secretsmanager_secret.coms_token` | Account-local copy of the hub token |
| `aws_secretsmanager_secret.provider_keys` | Model provider API keys, created empty |

Source: `deploy/modules/agent/main.tf`.

### Placement

The module defaults to the default VPC's first default subnet. That subnet can sit in an Availability Zone without the chosen instance type (us-east-1e has no t4g capacity), which fails the apply. Pin `subnet_id` to a default subnet in a supported zone. Both `subnet_id` and `instance_type` pass through the account root (`deploy/accounts/poc/main.tf`).

### Shell access

No inbound ports exist. Use Session Manager, then attach to the agent's terminal:

```bash
aws ssm start-session --target <instance-id> --region <region>
# on the host:
sudo -u piagent -i herdr
```

With `ssh_public_key` set, `herdr --remote` over an SSM tunnel also works.

### Running costs

Fixed cost per account, us-east-1 on-demand at ~730 hours/month:

| Item | Monthly |
|------|---------|
| EC2 t4g.micro | $6.13 |
| EBS 30 GB gp3 root volume | $2.40 |
| Public IPv4 address | $3.65 |
| Secrets Manager (2 secrets) | $0.80 |
| SSM, default CloudWatch metrics, data transfer | ~$0 |
| Total | ~$13.00 |

Each additional account adds the same amount. The default `instance_type` is t4g.small (~$12.26/mo for the instance alone); the poc account pins t4g.micro via tfvars, which fits the workload (~400 MB used of 1 GB, CPU under 3% idle).

Networking rounds to zero beyond the IPv4 address:

1. **Egress is inside the free tier.** AWS charges internet egress at $0.09/GB after the first free 100 GB/month per account. The agent's chatter -- heartbeats every 10 seconds, kilobyte-scale prompts and replies -- totals well under 1 GB/month.
2. **Ingress is always free**, which covers the SSE stream, keepalives, boot-time installs, and the repo clone.
3. **In-region AWS API traffic is free** between EC2 and regional service endpoints.
4. **The public IP replaces a NAT gateway.** Egress-only public IP costs $3.65/mo; a NAT gateway would cost ~$32/mo plus $0.045/GB processed for the same outbound-only role. There is no ALB or CloudFront either -- the hub's TLS lives on the VPS behind existing Traefik.

Model usage is the variable cost and is metered separately: idle agents consume no tokens (heartbeats and SSE are plain HTTP), and cost accrues only per query against the provider key in the account's `pi-agent/agent-provider-keys` secret. The fleet key is dedicated, so the provider's usage dashboard for that key reads as exactly the fleet's spend.

---

## Boot sequence on an agent host

Both shims converge on the same sequence in `deploy/bootstrap/agent-bootstrap.sh`:

```
+-----------+   clone    +------------+   secrets   +------------+   systemd   +-----------+
| shim sets | ---------> | install    | ----------> | write      | ----------> | herdr +   |
| env       |  repo_url  | bun/pi/    |  aws|file   | ~/.coms-env|  units      | pi-agent  |
| contract  |            | herdr      |             | (0600)     |             | services  |
+-----------+            +------------+             +------------+             +-----------+
```

1. Install Bun, Pi, and Herdr for the `piagent` user. The `pi` launcher is replaced with a Bun wrapper because the hosts have no Node (`deploy/bootstrap/agent-bootstrap.sh:74-93`).
2. Resolve secrets from Secrets Manager (`SECRETS_SOURCE=aws`) or env files (`SECRETS_SOURCE=file`) into `~/.coms-env`, mode 0600. Provider keys may be empty on first boot; the agent still registers.
3. Install `herdr.service` and `pi-agent.service`. The launch script (`~/bin/start-pi-agent.sh`) waits for Herdr and the hub, closes stale workspaces, starts Pi in a headless Herdr pane, and confirms readiness against the hub registry rather than Herdr's own detection.

### Gotchas

1. **Do not reboot during first boot.** Userdata runs once per instance; a reboot mid-bootstrap leaves a half-installed host that never recovers on its own. Recreate instead: `terraform apply -replace=module.agent.aws_instance.agent`.
2. **Secrets are read at bootstrap, not at service start.** `~/.coms-env` is written by the bootstrap only. Populating the provider-keys secret after boot requires re-running the bootstrap (or recreating the instance); a plain service restart reuses the stale env file.
3. **The public IP changes on stop/start.** Irrelevant to function (the host is egress-only) but do not hard-code it anywhere.
4. **Name collisions produce `name2`.** The hub appends a counter when a name is already held by a live session. The launch script guards against the common cause (stacked Herdr workspaces); if a name still sticks, restart the hub.

---

## Verifying a deployment

```bash
# Hub is up (no auth needed)
curl -s https://coms.siobytes.cloud/health

# Agent registered (token required)
curl -s -H "Authorization: Bearer $PI_COMS_NET_AUTH_TOKEN" \
  https://coms.siobytes.cloud/v1/agents
```

Expected: `/health` returns HTTP 200; the agents list contains `devops` and one `aws-<account_id>` entry per applied account.

On an agent host:

```bash
systemctl status herdr pi-agent
journalctl -u pi-agent -f
tail /var/log/pi-agent-bootstrap.log   # AWS hosts; ends with "bootstrap complete"
```

---

## See Also

- [System Overview](../architecture/overview.md)
- [Networking](../architecture/networking.md)
- [Security Model](../security/security-model.md)
- [Usage](../development/usage.md)
- `deploy/README.md` and `deploy/hostinger/README.md` for operator-focused runbooks
