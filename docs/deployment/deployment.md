# Deployment

Deploys the pi-coms star topology inside the corporate AWS estate: one
zero-permission hub on a private EC2 host, and one read-only Pi agent (plus
its monitor) per AWS account, all connected over the Transit Gateway with no
public exposure anywhere.

```
operator laptop (SSM tunnel / VPN) ──┐
eu-shared-services-dev + monitor ────┼──▶ hub (private EC2, 10.34.89.51:8787)
eu-oit-dev + monitor ────────────────┘        systemd unit coms-hub
```

> For the networking and trust model behind these choices, see
> [networking.md](../architecture/networking.md) and
> [security-model.md](../security/security-model.md).

## Components

| Component | Where it runs | Source |
|-----------|---------------|--------|
| Hub | Private EC2 in shared-services, systemd unit `coms-hub` | `deploy/modules/hub/` |
| AWS agent (one per account) | EC2 via Terraform | `deploy/modules/agent/`, `deploy/accounts/<name>/` |
| Account monitor (`pi-monitor.service`) | Same host as each agent | `scripts/coms-net-monitor.ts`, installed by the shared bootstrap |
| Shared bootstrap | Every agent host | `deploy/bootstrap/agent-bootstrap.sh` |
| Fleet distribution | S3 bucket in shared-services | `deploy/publish-fleet.sh`, State Manager convergence |

All install and launch logic lives in the shared bootstrap, parameterized by
`SECRETS_SOURCE=aws|file`; the userdata shim only sets the environment
contract documented at the top of `deploy/bootstrap/agent-bootstrap.sh` and
hands off.

## Accounts and roots

One Terraform root per account under `deploy/accounts/`, each with local
state and gitignored tfvars:

| Root | Instantiates |
|------|--------------|
| `eu-shared-services-dev` | Hub (private IP pinned) + the local agent |
| `eu-oit-dev` | Agent only, `hub_url` pointed at the hub's private IP |

Both roots use `lifecycle ignore_changes [ami]` and
`user_data_replace_on_change = true`: **any userdata-affecting change
replaces instances**. Always read the "forces replacement" lines of a plan.
Per-host configuration that must not churn instances belongs in the
bootstrap, not in terraform/userdata (for example `PI_MONITOR_REPORT_TO`).

## Code distribution: the fleet bundle

Development stays on GitHub; fleet hosts never talk to it. Merges to `main`
are published as a bundle to a versioned S3 bucket, and hosts converge from
inside the network:

| Stage | Mechanism |
|-------|-----------|
| Publish | `./deploy/publish-fleet.sh pi-coms-dist-<account> <profile>` uploads the archive + vendored deps next to a `version` file |
| Authorize | Bucket policy scoped with `aws:PrincipalOrgID`; hosts read via an S3 gateway endpoint (no internet path for code) |
| Converge | A State Manager association runs `pi-coms-update` every 30 min, comparing the S3 `version` to the local `.bundle-version` and swapping + restarting services on change |
| Immediate rollout | `aws ssm send-command ... --parameters 'commands=["/usr/local/bin/pi-coms-update"]'` per host |

`pi-coms-update` restarts `pi-monitor` (and `coms-hub` on the hub host) but
leaves a live registered Pi agent alone. When `extensions/` changed, follow
with the agent restart dance: `pkill -TERM -u piagent -f cli.js`, wait for
the name to leave the registry, then `systemctl restart pi-agent` -- a bare
unit restart sees "already registered" and leaves the old process running.

The daily digest carries the running `bundle:` version as the deploy canary,
so a stale host is visible from the mailbox without an SSM round-trip.

## IAM and models

Corp agents run under the production incident analyzer's
`DevOpsAgentReadOnly` role (both policy documents vendored verbatim in
`deploy/modules/agent/policies/`), assumed by the instance role with an
ExternalId. Named dev extensions live in the inline
`pi-coms-dev-extensions` policy: Cost Explorer, Bedrock invoke, scheduling
and history reads, log-content reads, certificate reads, and an explicit
Deny on secret values and data-plane gets. Models run on Amazon Bedrock
(`eu.anthropic.claude-sonnet-5`) under the same assumed role -- no API keys
exist anywhere in the system. Details: [Security Model](../security/security-model.md).

## Boot sequence on an agent host

```
+-----------+   bundle    +------------+   secrets   +------------+   systemd   +-----------+
| shim sets | ----------> | install    | ----------> | write      | ----------> | herdr +   |
| env       |   from S3   | bun/pi/    |  aws|file   | ~/.coms-env|  units      | pi-agent, |
| contract  |             | herdr      |             | (0600)     |             | pi-monitor|
+-----------+             +------------+             +------------+             +-----------+
```

1. Install Bun, Pi, and Herdr for the `piagent` user.
2. Wait for STS (`sts get-caller-identity` poll) before the first
   credentialed call -- first boot has an IMDS credential gap.
3. Resolve secrets into `~/.coms-env`, mode 0600.
4. Copy `deploy/AGENTS-spoke.md` into the clone as `AGENTS.override.md`
   (agent hosts only) so spokes load the investigation discipline instead of
   the repo's development instructions.
5. Install `herdr.service`, `pi-agent.service`, `pi-monitor.service`. The
   monitor is deliberately independent of the agent: a wedged agent never
   stops detection.

Re-run the whole bootstrap idempotently on a live host via SSM:

```bash
aws ssm send-command --instance-ids <id> --region <region> --profile <name> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["bash /var/lib/cloud/instance/user-data.txt"]'
```

Hosts pull this repository's **default branch** bundle: changes must be
merged to `main` and published before a boot or re-run picks them up.

### Gotchas

1. **Do not reboot during first boot.** Userdata runs once; recreate instead
   (`terraform apply -replace=...`).
2. **SSM quoting.** For anything beyond a trivial command, write a script
   locally, base64 it, and run
   `echo <b64> | base64 -d > /tmp/x.sh && bash /tmp/x.sh`. `aws ssm wait
   command-executed` gives up after ~100 s -- poll status in a loop for long
   commands.
3. **Terraform replacement trap.** Any userdata-affecting change replaces
   instances (see Accounts and roots above).
4. **Agent hosts need 2 GB of memory.** A 1 GB t4g.micro OOM-killed its
   agent mid-investigation; hosts are t4g.small with a 2 GB swapfile
   provisioned by the bootstrap.
5. **Name collisions produce `name2`.** In directory-auth mode names are
   bound to principals and squatting is rejected instead.

## Verifying a deployment

The hub is private; verification runs over SSM.

```bash
# Per host: bundle version and services
aws ssm send-command --instance-ids <id> --profile <profile> --region eu-central-1 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cat /home/piagent/pi-coms/.bundle-version && systemctl is-active pi-agent pi-monitor herdr"]'

# Monitor registered with its cadences (first log line)
journalctl -u pi-monitor -n 40   # via an SSM shell on the host

# Hub-side: monitors register --explicit and are hidden from /v1/agents;
# their register lines are in the hub journal
journalctl -u coms-hub           # on the hub host
```

From an operator session, `ask monitor-<alias> for status` answers with its
last run and unsent-report count without spending tokens on the monitor
side; the daily digest in the `ops` inbox is the standing dead-man signal.

## The deprecated VPS deployment

The original hub ran in Docker behind Traefik on a Hostinger VPS
(`deploy/hub/Dockerfile`, `deploy/hostinger/`), with a `devops` agent on the
same host. That estate is DEPRECATED as of 2026-08-31: do not deploy to it.
Two standing cautions while its pieces still exist: `/srv/pi-coms` on the
VPS is a plain file copy inside another repo's checkout -- never run git
there -- and hub deploys there were scp + `docker compose up -d --build`,
not the S3 bundle flow.

## See Also

- [System Overview](../architecture/overview.md)
- [Networking](../architecture/networking.md)
- [Monitoring](../architecture/monitoring.md) -- what `pi-monitor.service` does once installed
- [Estate Watch](../architecture/estate-watch.md) -- the doctrine behind the monitor
- [Security Model](../security/security-model.md)
- [Usage](../development/usage.md)
