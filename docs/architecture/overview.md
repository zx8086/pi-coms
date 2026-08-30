# System Overview

pi-coms gives Pi Coding Agent instances peer-to-peer messaging. Two equal agents talk directly -- same machine, LAN, or across the internet through a shared hub. There is no orchestrator and no parent/child hierarchy: every participant is a full Pi session that can send, receive, and answer.

The repository holds two layers:

1. **Extensions** (`extensions/`) -- standalone TypeScript files loaded into Pi via `-e`, implementing the two transports and their tool surfaces.
2. **Deployment** (`deploy/`) -- a star topology: a zero-permission hub on a VPS and one read-only Pi agent per AWS account.

```
laptop pi ──────────┐
aws-356994971776 ───┼──▶ hub (coms.siobytes.cloud, no AWS permissions)
devops (VPS) ───────┘
```

## Components

| Component | File | Role |
|-----------|------|------|
| Local transport | `extensions/coms.ts` | Same-machine peers over Unix sockets; file registry at `~/.pi/coms/` |
| Networked client | `extensions/coms-net.ts` | HTTP + Server-Sent Events (SSE) client to a hub |
| Hub | `scripts/coms-net-server.ts` | Bun HTTP server; in-memory registry and message relay |
| Shared bootstrap | `deploy/bootstrap/agent-bootstrap.sh` | Installs and launches a cloud agent; shared by AWS and VPS |
| Agent module | `deploy/modules/agent/` | Terraform: one EC2 agent per AWS account |
| Theme module | `extensions/themeMap.ts` | Shared helper (not an extension); per-extension theme and title defaults |

## Design principles

1. **Peers, not workers.** Every agent is a complete Pi session with its own model, tools, and working directory. Any peer can address any other by name.
2. **The hub holds no power.** It relays messages and tracks liveness; it has no cloud permissions and stores nothing durable. All state is process memory, so it must run as exactly one instance.
3. **Outbound-only agents.** Cloud agents open an SSE stream to the hub and receive prompts over it. No agent host accepts inbound connections; account access is bounded by an IAM role, not by network position.
4. **Replies are automatic.** An inbound prompt triggers a normal Pi turn; the final assistant message of that turn is submitted back to the caller by the extension. Tools are never used to reply (see [Communication](communication.md)).
5. **One shared bootstrap.** All install and launch logic lives in one script parameterized by `SECRETS_SOURCE=aws|file`; the AWS userdata and VPS shims only set environment.

## The two transports

| | `coms` (local) | `coms-net` (networked) |
|---|---|---|
| Transport | Unix sockets / named pipes | HTTP + SSE via the hub |
| Registry | JSON files, `~/.pi/coms/projects/<project>/agents/` | Hub process memory |
| Liveness | `process.kill(pid, 0)` + 10 s pings | 10 s heartbeats; hub marks stale at 30 s, evicts at 60 s |
| Name collisions | Client appends a counter | Hub appends a counter; client adopts the assigned name |
| Auth | OS file permissions (registry dir mode 0700) | Bearer token on every `/v1/*` request |
| Tools | `coms_list/send/get/await` | `coms_net_list/send/get/await/broadcast` |

Both extensions share the same shape: register an identity (`--cname`, `--purpose`, `--project`, `--color`), render a peer-pool widget below the editor, expose the tool surface, auto-reply on `agent_end`, and write an audit log that never contains prompt bodies.

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

Extensions are standalone `.ts` files loaded from source through Pi's jiti runtime; there is no build step. Tools are registered at the top level of the extension function, not inside event handlers. Every extension calls `applyExtensionDefaults(import.meta.url, ctx)` in `session_start` (`extensions/themeMap.ts:60-89`), which applies a theme only when that extension is the primary (first `-e` argument).

## See Also

- [Communication](communication.md) -- tool surface and message lifecycle
- [Networking](networking.md) -- listeners, discovery, and the wire path
- [Security Model](../security/security-model.md)
- [Deployment](../deployment/deployment.md)
- [Usage](../development/usage.md)
