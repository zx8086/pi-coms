# pi-coms

Peer-to-peer communication for [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) instances, plus deployment for a multi-account AWS fleet. Two equal Pi agents talk to each other directly -- same machine, LAN, or across the internet through a shared hub. No orchestrator, no parent/child hierarchy.

```
operator laptop ─────────────────┐
eu-shared-services-dev + monitor ┼──▶ hub (zero-permission relay, private EC2)
eu-oit-dev + monitor ────────────┘
```

Each AWS account runs its own agent with a read-only IAM role; from one session you address any of them by name, or all of them at once. Each account host also runs a deterministic monitor (`monitor-<agent-name>`) that checks alarms, logs, drift, cost, certificates, and CloudTrail on a schedule and mails findings through the hub's store-and-forward mailbox -- reports wait in the shared `ops` inbox even when your session is offline.

## Prerequisites

| Tool            | Purpose                   | Install                                                    |
| --------------- | ------------------------- | ---------------------------------------------------------- |
| **Bun** >= 1.4  | Runtime & package manager (`Bun.cron` for the monitor) | [bun.sh](https://bun.sh)                    |
| **just**        | Task runner               | `brew install just`                                        |
| **pi**          | Pi Coding Agent CLI       | [Pi docs](https://github.com/mariozechner/pi-coding-agent) |

## Setup

```bash
bun install
cp .env.sample .env   # fill in provider API keys
```

Pi does not auto-load `.env`. The `just` recipes load it via `set dotenv-load`; running `pi` directly requires `source .env` first.

## Tool surface

| Tool | What it does |
| --- | --- |
| `*_list` | List peer agents with names, models, live context usage |
| `*_send` | Send a prompt to one peer; returns a `msg_id` on ack. Optional `ttl_ms` queues durably for an offline name (hub mailbox, up to 14 days) |
| `*_get` | Non-blocking poll on `msg_id` |
| `*_await` | Block until the reply lands or a timeout fires |
| `coms_net_broadcast` | One prompt to all (or selected) peers; replies gathered in parallel |

Replies travel back automatically: when an inbound prompt triggers a turn, the receiver's final assistant message is packaged as the response.

## Quick start -- networked

```bash
# Terminal 1 -- hub
just coms-net-server           # binds 127.0.0.1, auto-generates a token
# or LAN-visible (requires PI_COMS_NET_AUTH_TOKEN in .env):
just coms-net-server-lan

# Terminals 2+ -- clients (auto-discover local server.json)
just coms dev
just coms prod --model claude-opus-4-7   # extra args pass through to pi
```

The agent name flag is `--cname` (Pi owns `--name` and resumes it across sessions). The recipe sets both from one value: the Pi session is named `<name> <timestamp>` so runs are traceable, and `--explicit` keeps the operator out of peer auto-discovery.

For a remote hub, set `PI_COMS_NET_SERVER_URL` and `PI_COMS_NET_AUTH_TOKEN` in `.env`.

## Install as a Pi package

The repository is a [Pi package](https://pi.dev/docs/latest/packages): the `pi` manifest in `package.json` points at `extensions/coms-net.ts`. Anyone running Pi can install the extension without cloning this repo or installing Bun.

```bash
# From GitHub, pinned to a tag
pi install https://github.com/zx8086/pi-coms@v0.1.0

# From a shared bundle: unpack pi-coms-<version>.tgz (built with `npm pack`) and point Pi at the directory
pi install /absolute/path/to/pi-coms
```

Then connect to a hub and start Pi:

```bash
export PI_COMS_NET_SERVER_URL=http://127.0.0.1:8787   # hub URL, e.g. the corp hub through an SSM tunnel
export PI_COMS_NET_AUTH_TOKEN=<token>                 # from the hub operator (just token-create)
pi --cname <name> --explicit
```

On the same machine as a hub, both variables can be left unset: the extension discovers `~/.pi/coms-net/projects/default/server.json` and the auto-generated token.

To roll the extension out with a team repository, commit a `.pi/settings.json` containing `"packages": ["https://github.com/zx8086/pi-coms@v0.1.0"]`; Pi installs it on the first trusted start. Running a hub still requires Bun: `bun <package path>/scripts/coms-net-server.ts`.

Do not install the package on a machine where you also run `just coms` from this checkout: the extension would load twice and its tools would collide.

## Speaking to the fleet

From any client session:

- "ask eu-oit-dev how many RDS instances it sees" -- routed via `coms_net_send` / `coms_net_await` to that one agent.
- "ask everyone to summarize their environment" -- `coms_net_broadcast` fans out to every online peer and returns each reply under its name.

## Account monitoring

Each deployed AWS host runs `pi-monitor.service` (`scripts/coms-net-monitor.ts`): deterministic checks every 15 minutes (alarm transitions, log error scan, infrastructure drift), hourly (log ingestion heartbeat), and daily (cost vs a 14-day baseline, CloudTrail status, certificate expiry, write-event watchlist), with zero token spend when quiet. Findings are investigated by the account's Pi agent and reported to the `ops` inbox via the mailbox; a daily digest doubles as the dead-man signal. Prompt it directly: `ask monitor-eu-oit-dev for status`. Details in [`docs/architecture/monitoring.md`](docs/architecture/monitoring.md).

## Tests

```bash
bun run typecheck   # strict tsc over scripts/ and tests/
bun test
```

Both gate `main` in CI (`.github/workflows/ci.yml`). Unit tests cover the monitor checks, state, and report pipeline; integration tests spawn the real hub in a temp `HOME` to exercise the mailbox (queueing, flush-on-connect, restart recovery).

## Deployment

See [`docs/deployment/deployment.md`](docs/deployment/deployment.md): a private EC2 hub, a Terraform module that puts one read-only Pi agent (plus its monitor) into each AWS account, and the S3 bundle every host converges from. Operational pitfalls are collected in [`docs/deployment/operations-gotchas.md`](docs/deployment/operations-gotchas.md).

## Safety rails

- Hop limit (`PI_COMS_NET_MAX_HOPS`, default 5) stops runaway forwarding loops.
- Audit log of every send/receive (msg_id, sender, hops -- never prompt bodies).
- Stale-peer detection: heartbeats every 10s; dead peers marked and pruned.
- The hub refuses to bind beyond 127.0.0.1 without an explicit auth token.
