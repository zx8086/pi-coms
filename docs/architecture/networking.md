# Networking

How pi-coms components find each other and what travels over the wire. Two transports exist: Unix sockets for same-machine peers (`coms`) and HTTP plus Server-Sent Events (SSE) for networked peers (`coms-net`). This document covers listeners, ports, discovery, and the path a byte takes from a laptop to an AWS agent.

## Transport comparison

| | `coms` (local) | `coms-net` (networked) |
|---|---|---|
| Transport | Unix sockets / named pipes | HTTP + SSE |
| Scope | One machine | Same machine, LAN, or remote URL |
| Server | None -- agents listen directly | `scripts/coms-net-server.ts` |
| Registry | Files under `~/.pi/coms/` | Hub process memory |
| Auth | OS file permissions | Bearer token on every `/v1/*` request |

---

## Hub listeners and ports

The hub is a single Bun HTTP server. Bind address and port come from the environment (`scripts/coms-net-server.ts:31-32`):

| Variable | Default | Notes |
|----------|---------|-------|
| `PI_COMS_NET_HOST` | `127.0.0.1` | Non-loopback binds require an explicit auth token |
| `PI_COMS_NET_PORT` | `0` | `0` lets the OS claim a port; the claimed port lands in `server.json` |
| `PI_COMS_NET_PUBLIC_URL` | local URL | Advertised to clients via `server.json` |

In production the container binds `0.0.0.0:8787` inside its own network namespace, published only on host loopback (`127.0.0.1:8787`). Traefik runs with `network_mode: host`, so it reaches the hub over loopback and nothing else can (`deploy/hostinger/docker-compose.yml:24-25`).

```
                     internet
                        |
                        v  443 (TLS, *.siobytes.cloud wildcard)
              +--------------------+
              |      Traefik       |  network_mode: host
              +---------+----------+
                        |  http://127.0.0.1:8787  (loopback only)
                        v
              +--------------------+
              |      coms-hub      |  Docker, Bun
              +--------------------+
```

Traefik terminates TLS for `coms.siobytes.cloud` and forwards plain HTTP to loopback (`deploy/hostinger/traefik-router.yml`). No basicAuth middleware sits in front: the hub authenticates `/v1/*` itself and `/health` is deliberately open for healthchecks.

---

## Discovery

A coms-net client finds its hub in one of two ways:

1. **Explicit configuration**: `--server-url`/`--auth-token` flags or `PI_COMS_NET_SERVER_URL`/`PI_COMS_NET_AUTH_TOKEN` environment variables. This is how every deployed agent and `connect.sh` work.
2. **Local discovery file**: a hub writes `~/.pi/coms-net/projects/<project>/server.json` at startup and unlinks it on shutdown (`scripts/coms-net-server.ts:1472-1485`). Clients on the same machine read it to find the URL.

`server.json` contents (never includes the token):

```json
{
  "version": 1,
  "project": "default",
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 52965,
  "local_url": "http://127.0.0.1:52965",
  "public_url": "https://coms.siobytes.cloud",
  "started_at": "...",
  "server_id": "..."
}
```

When the hub generates its own token (loopback bind without `PI_COMS_NET_AUTH_TOKEN`), it writes the token to `server.secret.json` next to `server.json`, mode 0600 (`scripts/coms-net-server.ts:1489-1501`).

---

## HTTP surface

All routes except `/health` require `Authorization: Bearer <token>`. Full behavior lives in `scripts/coms-net-server.ts:1226-1305`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness and identity: `{ok, version, server_id, started_at}` |
| POST | `/v1/agents/register` | Register a session; returns the agent card and SSE URL |
| GET | `/v1/events` | The SSE stream (see below) |
| GET | `/v1/agents` | List agents in a project |
| POST | `/v1/agents/:session_id/heartbeat` | Liveness plus context/queue stats |
| DELETE | `/v1/agents/:session_id` | Deregister |
| POST | `/v1/messages` | Send a prompt to one target; optional `ttl_ms` queues durably for an offline name (see [Monitoring](monitoring.md#the-hub-mailbox)) |
| GET | `/v1/messages/:id` | Non-blocking status poll |
| GET | `/v1/messages/:id/await` | Long-poll until terminal or timeout |
| POST | `/v1/messages/:id/response` | Target submits the reply |

A `server_id` change between `/health` polls means the hub restarted and its in-memory registry was lost. Mailbox messages are not: non-terminal messages reload from `messages.db` on boot.

---

## The SSE channel

Each registered session holds one `GET /v1/events` stream open. The hub pushes:

| Event | Meaning |
|-------|---------|
| `hello` | First frame; server identity |
| `pool_snapshot` | Current peers at connect time |
| `agent_joined` / `agent_left` / `agent_stale` / `agent_updated` | Registry changes |
| `prompt` | An inbound message for this session |
| `message_status` | Delivery state changes for messages this session sent |
| `response` | A reply to a message this session sent |

Keepalive comments go out every 15 seconds; the Bun server runs with `idleTimeout: 0` so streams are never cut by the runtime. There is no event replay, with one deliberate exception: right after `hello` and `pool_snapshot`, the hub flushes the session's queued mailbox messages oldest-first as `prompt` events. Otherwise a reconnect gets fresh state only, and a reconnect for the same session replaces the previous stream.

This channel is why every host only needs **outbound** connectivity. The hub never dials an agent; prompts ride the SSE stream the agent itself opened.

---

## Liveness timing

| Constant | Value | Source |
|----------|-------|--------|
| Heartbeat interval (advertised to clients) | 10 s | `PI_COMS_NET_HEARTBEAT_MS` |
| Marked stale after | 30 s | `PI_COMS_NET_STALE_AFTER_MS` |
| Evicted after | 60 s | `PI_COMS_NET_OFFLINE_AFTER_MS` |
| Stale scan cadence | 5 s | `scripts/coms-net-server.ts:45` |
| SSE keepalive | 15 s | `scripts/coms-net-server.ts:47` |

---

## Agent host networking (AWS)

The EC2 host sits in a default-VPC public subnet with a public IP for egress and a security group with **no ingress rules** (`deploy/modules/agent/main.tf:41-54`). This trades a NAT gateway for a public IP that accepts nothing.

| Direction | Traffic | Path |
|-----------|---------|------|
| Outbound | Hub registration, heartbeats, SSE (agent and monitor each hold one stream) | HTTPS to `coms.siobytes.cloud` |
| Outbound | Boot-time installs, repo clone | HTTPS to bun.sh, GitHub, herdr.dev |
| Outbound | Secrets, AWS API queries, monitor checks | HTTPS to regional AWS endpoints (Cost Explorer: us-east-1) |
| Inbound | None | Shell access is SSM Session Manager (outbound-initiated) |

The VPS agent short-circuits Traefik entirely and talks to the hub over loopback (`http://127.0.0.1:8787`), so it keeps working while the cert or router is being changed (`deploy/hostinger/bootstrap-agent.sh:39-41`).

## End-to-end path

A prompt from the laptop to an AWS agent:

```
laptop pi ---> https://coms.siobytes.cloud (Traefik:443)
                 ---> http://127.0.0.1:8787 (hub)   POST /v1/messages
hub ------------> SSE "prompt" event on the stream the
                  AWS agent opened outbound            (no inbound to AWS)
aws agent ------> POST /v1/messages/:id/response  ---> hub
hub ------------> SSE "response" event -------------> laptop pi
```

## See Also

- [Communication](communication.md) for message semantics on top of this transport
- [Security Model](../security/security-model.md) for the trust boundaries at each hop
- [Deployment](../deployment/deployment.md) for how each listener is stood up
