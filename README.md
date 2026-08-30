# pi-coms

Peer-to-peer communication for [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) instances, plus deployment for a multi-account AWS fleet. Two equal Pi agents talk to each other directly -- same machine, LAN, or across the internet through a shared hub. No orchestrator, no parent/child hierarchy.

```
laptop pi ──────────┐
aws-111111111111 ───┼──▶ hub (zero-permission relay)
aws-222222222222 ───┤
devops (VPS) ───────┘
```

Each AWS account runs its own agent with a read-only IAM role; from one session you address any of them by name, or all of them at once.

## Prerequisites

| Tool            | Purpose                   | Install                                                    |
| --------------- | ------------------------- | ---------------------------------------------------------- |
| **Bun** >= 1.3  | Runtime & package manager | [bun.sh](https://bun.sh)                                   |
| **just**        | Task runner               | `brew install just`                                        |
| **pi**          | Pi Coding Agent CLI       | [Pi docs](https://github.com/mariozechner/pi-coding-agent) |

## Setup

```bash
bun install
cp .env.sample .env   # fill in provider API keys
```

Pi does not auto-load `.env`. The `just` recipes load it via `set dotenv-load`; running `pi` directly requires `source .env` first.

## Two transports

| | `coms` (local) | `coms-net` (networked) |
| --- | --- | --- |
| Transport | Unix sockets / named pipes | HTTP + Server-Sent Events |
| Scope | One machine | Same machine, LAN, or remote URL |
| Server | None -- agents listen directly | `bun scripts/coms-net-server.ts` |
| Tools | `coms_list/send/get/await` | `coms_net_list/send/get/await/broadcast` |
| Auth | OS file perms | `PI_COMS_NET_AUTH_TOKEN` bearer token |

## Tool surface

| Tool | What it does |
| --- | --- |
| `*_list` | List peer agents with names, models, live context usage |
| `*_send` | Send a prompt to one peer; returns a `msg_id` on ack |
| `*_get` | Non-blocking poll on `msg_id` |
| `*_await` | Block until the reply lands or a timeout fires |
| `coms_net_broadcast` | One prompt to all (or selected) peers; replies gathered in parallel |

Replies travel back automatically: when an inbound prompt triggers a turn, the receiver's final assistant message is packaged as the response.

## Quick start -- same machine

```bash
# Terminal 1
just local-coms --name planner --purpose "Plans the work"

# Terminal 2
just local-coms --name coder --purpose "Writes the code"
```

## Quick start -- networked

```bash
# Terminal 1 -- hub
just coms-net-server           # binds 127.0.0.1, auto-generates a token
# or LAN-visible (requires PI_COMS_NET_AUTH_TOKEN in .env):
just coms-net-server-lan

# Terminals 2+ -- clients (auto-discover local server.json)
just coms --name dev --cname dev
just coms2 --name prod --cname prod    # pinned to a different model
```

The agent name flag is `--cname` (Pi owns `--name` and resumes it across sessions); pass both so the session and the coms agent share a name.

For a remote hub, set `PI_COMS_NET_SERVER_URL` and `PI_COMS_NET_AUTH_TOKEN` in `.env`.

## Speaking to the fleet

From any client session:

- "ask aws-111111111111 how many RDS instances it sees" -- routed via `coms_net_send` / `coms_net_await` to that one agent.
- "ask everyone to summarize their environment" -- `coms_net_broadcast` fans out to every online peer and returns each reply under its name.

## Deployment

See [`deploy/README.md`](deploy/README.md): the hub as a Docker container behind any TLS proxy, a VPS bootstrap, and a Terraform module that puts one read-only Pi agent into each AWS account.

## Safety rails

- Hop limit (`PI_COMS_*_MAX_HOPS`, default 5) stops runaway forwarding loops.
- Audit log of every send/receive (msg_id, sender, hops -- never prompt bodies).
- Stale-peer detection: heartbeats every 10s; dead peers marked and pruned.
- The hub refuses to bind beyond 127.0.0.1 without an explicit auth token.
