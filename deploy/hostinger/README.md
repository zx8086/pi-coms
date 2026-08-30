# coms-net on server.siobytes.cloud

The Pi-to-Pi hub and a cloud Pi agent, running on the Hostinger VPS instead of
AWS. This VPS holds the hub; AWS accounts get agents via `deploy/modules/agent/`.

## Why this is so much smaller than the AWS version

The AWS stack spent most of its resources solving problems this box had already
solved. Traefik holds a `*.siobytes.cloud` wildcard certificate via Hostinger
DNS-01, so TLS needs no ACME wait and no DNS record. Binding the hub to
`127.0.0.1` makes it unreachable from the internet, which is what CloudFront's
managed prefix list plus the `X-Origin-Verify` header rule were for. No VPC, no
NAT gateway, no ALB, no ECS.

| Concern | AWS | Here |
|---|---|---|
| TLS | CloudFront default cert | Existing wildcard cert |
| Origin lockdown | Prefix list + header rule | `127.0.0.1` bind |
| Hub runtime | ECS Fargate + ECR | Docker Compose |
| Agent host | EC2 + instance profile | systemd on the VPS |
| Shell access | SSM Session Manager | Plain SSH |

## Layout

```
deploy/hub/Dockerfile              hub image (Bun, no install step)
deploy/hostinger/
  docker-compose.yml               hub service, bound to 127.0.0.1:8787
  traefik-router.yml               router + service to merge into Traefik
  bootstrap-agent.sh               installs Bun, Pi, Herdr, systemd units
  connect.sh                       connects a laptop Pi to the hub
```

On the VPS these live at `/srv/pi-coms/`.

## Secrets

Follows `/srv/secrets-store.md`: values stay in `/root/.secrets`, only paths are
committed.

| Path | Purpose |
|---|---|
| `server-siobytes-cloud/coms-net-hub.env` | `PI_COMS_NET_AUTH_TOKEN`, read by the hub container |
| `server-siobytes-cloud/openai-piagent.apikey` | `OPENAI_API_KEY` for the agent |

## Deploy

```bash
# 1. Hub token (once)
openssl rand -hex 32 | sed 's/^/PI_COMS_NET_AUTH_TOKEN=/' \
  > /root/.secrets/server-siobytes-cloud/coms-net-hub.env
chmod 600 /root/.secrets/server-siobytes-cloud/coms-net-hub.env

# 2. Hub
cd /srv/pi-coms/deploy/hostinger && docker compose up -d --build

# 3. Traefik route -- merge traefik-router.yml into
#    /srv/traefik/dynamic/routers.yml. Traefik watches the directory, so no
#    restart is needed. Back the file up first.

# 4. Agent
bash /srv/pi-coms/deploy/hostinger/bootstrap-agent.sh
```

## Connect from your laptop

```bash
./deploy/hostinger/connect.sh
```

That fetches the hub token (and a model key, if your shell has none and you have
not run `pi /login`) over SSH, prints the current peers, and starts Pi as
`laptop`. `source` it instead to set the environment without launching.

Doing it by hand:

```bash
export PI_COMS_NET_SERVER_URL=https://coms.siobytes.cloud
export PI_COMS_NET_AUTH_TOKEN="$(ssh server.siobytes.cloud \
  'cut -d= -f2- /root/.secrets/server-siobytes-cloud/coms-net-hub.env')"
export OPENAI_API_KEY="$(ssh server.siobytes.cloud \
  'cat /root/.secrets/server-siobytes-cloud/openai-piagent.apikey')"

pi -e extensions/coms-net.ts --cname laptop --model openai/gpt-5.4-mini
```

`devops` then appears in the coms-net widget and you address it by name.

## Watch the cloud agent's TUI

```bash
herdr --remote piagent-vps
```

That needs an SSH alias logging in as `piagent`, not root:

```
Host piagent-vps
  HostName 72.61.177.39
  User piagent
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

Authorize the key with `SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)"` set when
running the bootstrap.

Or open a shell and attach locally:

```bash
ssh server.siobytes.cloud
sudo -u piagent -i herdr
```

## Operating

```bash
docker compose -f /srv/pi-coms/deploy/hostinger/docker-compose.yml logs -f
systemctl status herdr pi-agent
journalctl -u pi-agent -f
```

Restarting the hub clears the registry, since it is in-memory. Agents
re-register on their next heartbeat (10s). Mailbox messages survive: the
sqlite store lives on the `coms-hub-mail` named volume
(`/home/bun/.pi/coms-net` in the container), reloaded on boot, so
store-and-forward mail outlives restarts and container recreation. See
`docs/architecture/monitoring.md`.

`/srv/pi-coms` holds plain copies of `deploy/` and `scripts/` from this repo
(it is not a git checkout -- `/srv` itself is a different repo's worktree, so
never run git commands in here). To update the hub: copy the changed files in,
then `docker compose up -d --build`.

## Gotchas

**Pi must run under Bun.** There is no Node on this host, and `bun install -g`
leaves a `#!/usr/bin/env node` shebang on the `pi` symlink. The bootstrap
replaces that symlink with a wrapper that execs Bun. A PATH-ordering fix is not
enough: Herdr launches Pi from a non-login shell that never sources `.bashrc`.

**Never write that wrapper straight to `~/.bun/bin/pi`.** That path is a symlink
into the package, so a plain redirect overwrites the real `cli.js` and Bun then
tries to parse shell script as JavaScript. Write to a temp file, `rm` the
symlink, then `mv` it into place -- which is what the bootstrap does. Recovering
from the corrupted state needs the Bun cache cleared as well, since a reinstall
otherwise restores the damaged copy:

```bash
rm -rf ~/.bun/install/global/node_modules/@mariozechner/pi-coding-agent \
       ~/.bun/install/cache
bun install -g @mariozechner/pi-coding-agent
```

**Do not scale the hub past one replica.** The agent registry and SSE
connections are in process memory, so a second container would split the
registry and peers would intermittently fail to find each other.

**`herdr agent start` always reports a timeout.** Herdr's readiness detection
never fires for Pi on this host, so the command blocks for its full timeout and
then reports failure -- even though Pi started and registered within seconds.
The timeout is therefore set to 15s, not 120s, and the launch script treats the
failure as non-fatal, polling the hub registry for the real readiness signal.

**Name collisions produce `devops2`.** The hub appends a counter when a name is
already held by a live session, and peers address agents by name -- so a bumped
agent is invisible to anyone sending to `devops` (`target_not_found`). The cause
here was the launch script stacking a new Herdr workspace on every restart while
the orphaned one kept its registration; it now closes stale workspaces first and
checks the hub, not `herdr agent list`, before deciding an agent is already up.
If a name still sticks, restart the hub -- the registry is in memory.

**Always qualify the model as `provider/id`.** `--model` takes a *pattern*, not
an exact id, so a bare `gpt-5.4-mini` fuzzy-matches to `azure-openai-responses`
and dies with `No API key for provider: azure-openai-responses` -- even though
`pi --list-models` shows the id under `openai` alone. Use
`--model openai/gpt-5.4-mini`.

**`openai` and `openai-codex` are different providers.** `OPENAI_API_KEY`
drives `openai`, which serves the `gpt-5.x` ids including the `gpt-5.4-mini`
this agent runs. `openai-codex` uses ChatGPT OAuth instead and ignores the key,
so a model id chosen from the wrong provider's list will not authenticate. Check
with `pi --list-models` once the key is set -- the list is empty without
credentials.

**Traefik cannot resolve container names** -- it runs `network_mode: host`. Give
it a `127.0.0.1:<port>` address, as the hub does, rather than a container IP.

**The shared bootstrap installs `pi-monitor.service` on this host too.** The
monitor is built for AWS accounts; on the VPS there are no AWS credentials, so
it registers as `monitor-aws-unknown`, journals a check error per family each
cycle, and still mails a daily digest. Harmless but noisy -- disable it here
with `systemctl disable --now pi-monitor` after a bootstrap re-run.
