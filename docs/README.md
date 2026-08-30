# Documentation Index

Project-specific documentation for pi-coms: peer-to-peer messaging between Pi Coding Agent instances plus the hub-and-spoke deployment. Reusable, project-agnostic guides live in the top-level [`guides/`](../guides/) directory.

## Quick Navigation

| Need to... | Go to... |
|------------|----------|
| Understand the system | [System Overview](architecture/overview.md) |
| See how messages flow | [Communication](architecture/communication.md) |
| Trace ports, discovery, TLS | [Networking](architecture/networking.md) |
| Understand the AWS monitor and mailbox | [Monitoring](architecture/monitoring.md) |
| Review trust boundaries and IAM | [Security Model](security/security-model.md) |
| Deploy the hub or an AWS agent | [Deployment](deployment/deployment.md) |
| Run and address the fleet | [Usage](development/usage.md) |

---

## By Category

### Architecture

| Document | Description |
|----------|-------------|
| [overview.md](architecture/overview.md) | Components, design principles, and the two transports |
| [communication.md](architecture/communication.md) | Tool surface, message lifecycle, auto-reply, broadcast, safety rails |
| [networking.md](architecture/networking.md) | Listeners, ports, discovery files, SSE channel, end-to-end wire path |
| [monitoring.md](architecture/monitoring.md) | Per-account AWS monitor, hub mailbox (store-and-forward), checks, reports |

### Security

| Document | Description |
|----------|-------------|
| [security-model.md](security/security-model.md) | Trust boundaries, hub auth, IAM role, secrets handling, prompt-injection posture |

### Deployment

| Document | Description |
|----------|-------------|
| [deployment.md](deployment/deployment.md) | VPS hub, per-account Terraform module, boot sequence, verification |

### Development

| Document | Description |
|----------|-------------|
| [usage.md](development/usage.md) | Recipes, connecting to the hub, fleet addressing, flags and environment knobs |

## Related Documentation

- [`README.md`](../README.md) -- prerequisites, setup, quick starts
- [`CLAUDE.md`](../CLAUDE.md) -- assistant working notes for this repository
- [`deploy/README.md`](../deploy/README.md) -- operator runbook for the star topology
- [`deploy/hostinger/README.md`](../deploy/hostinger/README.md) -- VPS specifics and gotchas
- [`guides/documentation-guide.md`](../guides/documentation-guide.md) -- the standards these docs follow

## Service Overview

| Aspect | Value |
|--------|-------|
| Transports | Unix sockets (`coms`), HTTP + SSE via hub (`coms-net`) |
| Hub | `scripts/coms-net-server.ts`, single Bun container at https://coms.siobytes.cloud; sqlite mailbox for store-and-forward |
| Agents | `devops` (VPS), one `aws-<account_id>` plus one `monitor-aws-<account_id>` per applied AWS account |
| Tool surface | `*_list`, `*_send`, `*_get`, `*_await`, `coms_net_broadcast` |
| Runtime | Bun; extensions load from source via Pi's jiti runtime, no build step |
| Tests | `bun test` (unit + hub integration suite under `tests/`) |
