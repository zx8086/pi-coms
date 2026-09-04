# Documentation Index

Project-specific documentation for pi-coms: peer-to-peer messaging between Pi Coding Agent instances plus the hub-and-spoke deployment. Reusable, project-agnostic guides live in the top-level [`guides/`](../guides/) directory.

## Quick Navigation

| Need to... | Go to... |
|------------|----------|
| Understand the system | [System Overview](architecture/overview.md) |
| See how messages flow | [Communication](architecture/communication.md) |
| Trace ports, discovery, TLS | [Networking](architecture/networking.md) |
| Understand the AWS monitor and mailbox | [Monitoring](architecture/monitoring.md) |
| See why the monitor checks what it checks | [Estate Watch](architecture/estate-watch.md) |
| Review trust boundaries and IAM | [Security Model](security/security-model.md) |
| Deploy the hub or an AWS agent | [Deployment](deployment/deployment.md) |
| Run and address the fleet | [Usage](development/usage.md) |
| Let the incident analyzer verify reports through the fleet | [Incident analyzer as a hub client](integrations/incident-analyzer.md) |

---

## By Category

### Architecture

| Document | Description |
|----------|-------------|
| [overview.md](architecture/overview.md) | Components, design principles, and the two transports |
| [communication.md](architecture/communication.md) | Tool surface, message lifecycle, auto-reply, broadcast, safety rails |
| [networking.md](architecture/networking.md) | Listeners, ports, discovery files, SSE channel, end-to-end wire path |
| [monitoring.md](architecture/monitoring.md) | Per-account AWS monitor, hub mailbox (store-and-forward), checks, suppression ledger, reports |
| [estate-watch.md](architecture/estate-watch.md) | The periodic-watch doctrine the monitor implements: check ladder, memory, field rules |

### Security

| Document | Description |
|----------|-------------|
| [security-model.md](security/security-model.md) | Trust boundaries, hub auth, IAM role, secrets handling, prompt-injection posture |

### Deployment

| Document | Description |
|----------|-------------|
| [deployment.md](deployment/deployment.md) | Corp hub and agents, per-account Terraform roots, fleet bundle distribution, boot sequence, verification |

### Development

| Document | Description |
|----------|-------------|
| [usage.md](development/usage.md) | Recipes, connecting to the hub, fleet addressing, flags and environment knobs |

### Integrations

| Document | Description |
|----------|-------------|
| [incident-analyzer.md](integrations/incident-analyzer.md) | The DevOps incident analyzer as a `service` principal: token, wire sequence, the verify and investigate prompts spokes receive, `ops` fallback, footprint |

## Related Documentation

- [`README.md`](../README.md) -- prerequisites, setup, quick starts
- [`CLAUDE.md`](../CLAUDE.md) -- assistant working notes for this repository
- [`AGENTS.md`](../AGENTS.md) -- operator-console instructions; [`deploy/AGENTS-spoke.md`](../deploy/AGENTS-spoke.md) -- the spoke agents' investigation discipline
- [`guides/documentation-guide.md`](../guides/documentation-guide.md) -- the standards these docs follow

## Service Overview

| Aspect | Value |
|--------|-------|
| Transports | Unix sockets (`coms`), HTTP + SSE via hub (`coms-net`) |
| Hub | `scripts/coms-net-server.ts`, single Bun process on a private EC2 host (systemd `coms-hub`); sqlite mailbox for store-and-forward and the durable inbox |
| Agents | One `<alias>` (e.g. `eu-shared-services-dev`) plus one `monitor-<alias>` per applied AWS account |
| Tool surface | `*_list`, `*_send`, `*_get`, `*_await`, `coms_net_broadcast` |
| Runtime | Bun; extensions load from source via Pi's jiti runtime, no build step |
| Tests | `bun test` (unit + hub integration suite under `tests/`) |
