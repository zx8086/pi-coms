# System Overview

pi-coms gives Pi Coding Agent instances peer-to-peer messaging. Two equal agents talk directly -- same machine, LAN, or across the internet through a shared hub. There is no orchestrator and no parent/child hierarchy: every participant is a full Pi session that can send, receive, and answer.

The repository holds two layers:

1. **Extensions** (`extensions/`) -- standalone TypeScript files loaded into Pi via `-e`: the networked client and its tool surface, plus small shared modules.
2. **Deployment** (`deploy/`) -- a star topology: a zero-permission hub on a private EC2 host and one read-only Pi agent (plus its deterministic monitor) per AWS account.

```
operator laptop ─────────┐
eu-shared-services-dev ──┼──▶ hub (private EC2, no AWS permissions)
eu-oit-dev ──────────────┘
```

## Components

| Component | File | Role |
|-----------|------|------|
| Networked client | `extensions/coms-net.ts` | HTTP + Server-Sent Events (SSE) client to a hub |
| Hub | `scripts/coms-net-server.ts` | Bun HTTP server; in-memory registry, message relay, sqlite mailbox for store-and-forward |
| Monitor | `scripts/coms-net-monitor.ts` + `scripts/monitor/` | Per-host AWS checks on `Bun.cron`; reports via the mailbox (see [Monitoring](monitoring.md)) |
| Shared bootstrap | `deploy/bootstrap/agent-bootstrap.sh` | Installs and launches a cloud agent and its monitor, parameterized by `SECRETS_SOURCE=aws\|file` |
| Agent module | `deploy/modules/agent/` | Terraform: one EC2 agent per AWS account, `DevOpsAgentReadOnly` workload role |
| Hub module | `deploy/modules/hub/` | Terraform: the private hub host, SG-scoped ingress, systemd unit |

## Design principles

1. **Peers, not workers.** Every agent is a complete Pi session with its own model, tools, and working directory. Any peer can address any other by name.
2. **The hub holds no power.** It relays messages and tracks liveness; it has no cloud permissions. The registry and streams are process memory (so it must run as exactly one instance), and its only durable state is the message mailbox -- a sqlite store-and-forward queue so long-TTL sends outlive restarts and offline recipients (see [Monitoring](monitoring.md#the-hub-mailbox)).
3. **Outbound-only agents.** Cloud agents open an SSE stream to the hub and receive prompts over it. No agent host accepts inbound connections; account access is bounded by an IAM role, not by network position.
4. **Replies are automatic.** An inbound prompt triggers a normal Pi turn; the final assistant message of that turn is submitted back to the caller by the extension. Tools are never used to reply (see [Communication](communication.md)).
5. **One shared bootstrap.** All install and launch logic lives in one script; the AWS userdata shim only sets environment.

## The transport

| | `coms-net` |
|---|---|
| Transport | HTTP + SSE via the hub |
| Registry | Hub process memory |
| Liveness | 10 s heartbeats; hub marks stale at 30 s, evicts at 60 s |
| Name collisions | Single-token hub appends a counter and the client adopts the assigned name (with a UI warning); directory mode refuses a held name with `409 name_taken` |
| Auth | Bearer token on every `/v1/*` request |
| Tools | `coms_net_list/send/get/await/broadcast/inbox` |

The extension registers an identity (`--cname`, `--purpose`, `--project`, `--color`), renders a peer-pool widget below the editor, exposes the tool surface, auto-replies on `agent_end`, and writes an audit log that never contains prompt bodies. Same-machine peers use the same client against a hub bound to `127.0.0.1` (`just coms-net-server`).

## A message end to end

```
+-----------+  coms_net_send   +---------+  SSE "prompt"   +-----------+
|  sender   | ---------------> |   hub   | --------------> | receiver  |
|  session  |                  |         |                 |  session  |
+-----------+                  +---------+                 +-----------+
      ^                             |                            |
      |     SSE "response"          |   POST /response           v
      +-----------------------------+<----------------- normal Pi turn;
                                                        final assistant
                                                        message auto-sent
```

The sender's `coms_net_send` returns a `msg_id` immediately; `coms_net_await` (or `coms_net_get`) picks up the reply. The receiver never calls a tool to answer -- its turn output is the answer.

## Extension conventions

Extensions are standalone `.ts` files loaded from source through Pi's jiti runtime; there is no build step. Tools are registered at the top level of the extension function, not inside event handlers.

## See Also

- [Communication](communication.md) -- tool surface and message lifecycle
- [Networking](networking.md) -- listeners, discovery, and the wire path
- [Monitoring](monitoring.md) -- the AWS account monitor and the hub mailbox
- [Estate Watch](estate-watch.md) -- the periodic-watch doctrine the monitor implements
- [Security Model](../security/security-model.md)
- [Deployment](../deployment/deployment.md)
- [Usage](../development/usage.md)
