# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# pi-coms

Peer-to-peer messaging between Pi Coding Agent instances (`coms` over Unix sockets, `coms-net` over HTTP/SSE) plus deployment: a zero-permission hub and one read-only Pi agent per AWS account.

## Commands

- Package manager: `bun` (not npm/yarn/pnpm). `bun install` to set up.
- Task runner: `just`; run `just` with no args to list recipes.
- Run a client: `just coms --name <n> --cname <n>` (coms-net) or `just local-coms --name <n>` (same-machine).
- Hub: `just coms-net-server` (localhost) or `just coms-net-server-lan` (requires `PI_COMS_NET_AUTH_TOKEN`).
- Tests: `bun test` (unit tests for monitor checks/state/report/cycle; integration tests spawn the real hub with `HOME` in a temp dir). No linter or build step; extensions load from source via Pi's jiti runtime. Syntax-check with `bun build extensions/<f>.ts --external '*' --outfile /dev/null`.
- Pi does not auto-load `.env`; `just` recipes do (`set dotenv-load`).

## Architecture

- `extensions/coms.ts` -- same-machine peers over Unix sockets; registry at `~/.pi/coms/`.
- `extensions/coms-net.ts` -- networked client. Hub is `scripts/coms-net-server.ts` (Bun HTTP/SSE, in-memory registry, cannot scale past one instance; sqlite mailbox at `~/.pi/coms-net/projects/<project>/messages.db` for store-and-forward). Discovers `~/.pi/coms-net/projects/<project>/server.json` or takes `--server-url`/`--auth-token`. Agent name flag is `--cname` (Pi owns `--name`).
- Mailbox: `coms_net_send` takes optional `ttl_ms`; beyond the 30-min default (cap `PI_COMS_NET_MAX_TTL_MS`, 7 d) a send to an offline name queues by name, flushes oldest-first on the target's next SSE connect, and survives hub restarts. Short-TTL sends keep fail-fast `target_not_found`.
- Monitor: `scripts/coms-net-monitor.ts` + `scripts/monitor/` -- per-AWS-host Bun process (`pi-monitor.service`), in-process `Bun.cron` (`*/15` alarms/logs/drift, `@daily` cost + digest), explicit peer `monitor-aws-<account_id>`, commands run-checks/status/digest/history, state in `~/.pi/monitor/state.db`, no model inside (warn+ findings investigated by the account's Pi agent, reports mailed to `PI_MONITOR_REPORT_TO`, default `laptop`). See `docs/architecture/monitoring.md`.
- Tool surface: `*_list`, `*_send`, `*_get`, `*_await`; coms-net adds `coms_net_broadcast` (fan-out to all/selected peers, replies gathered in parallel).
- Replies are automatic: an inbound prompt triggers a turn and the final assistant message is submitted back to the caller. Tools must never be used to reply (ping-pong loop guard is in the tool descriptions).
- Safety rails: hop limit (`PI_COMS*_MAX_HOPS`, default 5), audit log without prompt bodies, heartbeat/stale detection, localhost-only bind unless an auth token is set.
- `extensions/themeMap.ts` is a shared module (not an extension): every extension calls `applyExtensionDefaults(import.meta.url, ctx)` in `session_start`. Theme JSON lives in `~/.pi/agent/themes/`.

## Deployment (`deploy/`)

Star topology: the hub is a zero-permission relay; each AWS account is a spoke running its own agent with a `ViewOnlyAccess` instance role.

- `deploy/bootstrap/agent-bootstrap.sh` -- single shared bootstrap for every agent host, parameterized by `SECRETS_SOURCE=aws|file`. All install/launch logic lives here (installs `pi-agent.service` and `pi-monitor.service`); shims only set env. Re-run idempotently on a live AWS host via SSM: `bash /var/lib/cloud/instance/user-data.txt`.
- `deploy/modules/agent/` -- Terraform module, applied once per AWS account (see `deploy/accounts/`).
- `deploy/hub/Dockerfile`, `deploy/hostinger/` -- the hub container and its VPS home.
- Agents clone `repo_url` at boot (default branch, i.e. `main`): changes must be merged to `main` before a boot or bootstrap re-run picks them up.
- `deploy/modules/agent/main.tf` grants `ce:GetCostAndUsage` (inline `cost-explorer-read`) for the monitor's daily cost check; the role otherwise stays ViewOnlyAccess + named CloudWatch reads.
- On the VPS, `/srv/pi-coms` is a plain file copy, not a git checkout (`/srv` belongs to a different repo -- do not run git there); hub deploys are scp + `docker compose up -d --build`.

## Conventions

- Extensions are standalone .ts files; register tools at the top level of the extension function, not inside event handlers.
- Available imports: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, `@sinclair/typebox`, plus deps in package.json.
- Use `isToolCallEventType()` for type-safe `tool_call` event narrowing.
