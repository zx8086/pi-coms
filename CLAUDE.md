# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# pi-coms

Peer-to-peer messaging between Pi Coding Agent instances (`coms-net` over HTTP/SSE) plus deployment: a zero-permission hub and one read-only Pi agent per AWS account.

## Commands

- Package manager: `bun` (not npm/yarn/pnpm). `bun install` to set up.
- Task runner: `just`; run `just` with no args to list recipes.
- Run a client: `just coms <name>` (sets pi `--name "<name> <timestamp>"`, `--cname <name>`, `--explicit`; extra args pass to pi); same-machine peers use a hub on `127.0.0.1` (`just coms-net-server`).
- Hub: `just coms-net-server` (localhost) or `just coms-net-server-lan` (requires `PI_COMS_NET_AUTH_TOKEN`).
- Tests: `bun test` (unit tests for monitor checks/state/report/cycle; integration tests spawn the real hub with `HOME` in a temp dir). Typecheck: `bun run typecheck` (strict `tsc --noEmit` over `scripts/` and `tests/`; `extensions/` is excluded because Pi's packages resolve from the global Pi install, not `node_modules`). Both gate `main` via `.github/workflows/ci.yml`. No build step; extensions load from source via Pi's jiti runtime. Syntax-check an extension with `bun build extensions/<f>.ts --external '*' --outfile /dev/null`.
- Pi does not auto-load `.env`; `just` recipes do (`set dotenv-load`).

## Architecture

- `extensions/coms-net.ts` -- networked client. Hub is `scripts/coms-net-server.ts` (Bun HTTP/SSE, in-memory registry, cannot scale past one instance; sqlite mailbox at `~/.pi/coms-net/projects/<project>/messages.db` for store-and-forward). Discovers `~/.pi/coms-net/projects/<project>/server.json` or takes `--server-url`/`--auth-token`. Agent name flag is `--cname` (Pi owns `--name`).
- Mailbox: `coms_net_send` takes optional `ttl_ms`; beyond the 30-min default (cap `PI_COMS_NET_MAX_TTL_MS`, 14 d) a send to an offline name queues by name, flushes oldest-first on the target's next SSE connect, and survives hub restarts. Short-TTL sends keep fail-fast `target_not_found`. Mailbox-class prompts never trigger a turn on the recipient (passive notice only; read via `coms_net_inbox`).
- Monitor: `scripts/coms-net-monitor.ts` + `scripts/monitor/` -- per-AWS-host Bun process (`pi-monitor.service`), in-process `Bun.cron` (`*/15` alarms/logs/drift, hourly ingestion, `@daily` cost/trail/certs/watchlist + digest, `@weekly` suppression review), explicit peer `monitor-<agent_name>` (`monitor-eu-oit-dev`, `monitor-eu-shared-services-dev`), commands run-checks/status/digest/review/history/suppress/unsuppress/suppressions, state in `~/.pi/monitor/state.db`, no model inside (warn+ findings investigated by the account's Pi agent, reports mailed to `PI_MONITOR_REPORT_TO`; the bootstrap sets `ops`). See `docs/architecture/monitoring.md`.
- Tool surface: `coms_net_list`, `coms_net_send`, `coms_net_get`, `coms_net_await`, `coms_net_broadcast` (fan-out to all/selected peers, replies gathered in parallel), `coms_net_inbox` (read-many durable inbox: terminal mailbox messages retained until TTL expiry, `GET /v1/mailbox`, readable by every authenticated principal by design).
- Replies are automatic: an inbound prompt triggers a turn and the final assistant message is submitted back to the caller. Tools must never be used to reply (ping-pong loop guard is in the tool descriptions).
- Safety rails: hop limit (`PI_COMS_NET_MAX_HOPS`, default 5), audit log without prompt bodies, heartbeat/stale detection, localhost-only bind unless an auth token is set, 1 MiB request body cap, project names restricted to plain directory names.
- Auth: single shared token by default; directory mode (`PI_COMS_NET_AUTH_SSM_PATH` or `PI_COMS_NET_AUTH_FILE`) gives per-principal tokens with name binding, session ownership (only the registering principal may heartbeat, stream, delete, send as, or answer for a session), and refresh-based revocation; admin via `just token-create/revoke/list`.

## Deployment (`deploy/`)

Star topology inside the corp AWS estate: the hub is a zero-permission relay on a private EC2 host in shared-services (`deploy/modules/hub/`, systemd unit `coms-hub`, pinned private IP, mailbox on a dedicated EBS volume that outlives the instance); each AWS account is a spoke (`deploy/modules/agent/`, one root per account under `deploy/accounts/`) running one read-only Pi agent plus its monitor. Full runbook: `docs/deployment/deployment.md`; operational gotchas: `docs/deployment/operations-gotchas.md`.

- `deploy/bootstrap/agent-bootstrap.sh` -- the single bootstrap for every agent host. All install/launch logic lives here (installs `herdr.service`, `pi-agent.service`, `pi-monitor.service`); the userdata shim only sets env. Re-run idempotently on a live host via SSM: `bash /var/lib/cloud/instance/user-data.txt`.
- Code reaches hosts from an S3 bundle, never from GitHub: `deploy/publish-fleet.sh` uploads `bundle.tar.gz` + `version`; a State Manager association runs `pi-coms-update` on every host (hub included) every 30 min. Publishing is a manual step today. The git-clone boot path in the bootstrap is legacy for hosts without `bundle_s3_uri`.
- Terraform roots use `user_data_replace_on_change = true`: any userdata-affecting change replaces the instance. Per-host config that must not churn instances goes in the bootstrap.
- IAM: the workload assumes the account's `DevOpsAgentReadOnly` role (both prod policy documents vendored in `deploy/modules/agent/policies/`) plus the inline `pi-coms-dev-extensions` policy (Cost Explorer, Bedrock invoke, cert/WAF reads, explicit Deny on secret values). The instance role is host plumbing only (SSM, its parameters, the bundle bucket). Models run on Bedrock under the assumed role; there are no API keys.
- The agent module also creates a `StatusCheckFailed` alarm on each agent host (no actions; the monitor reports its transitions).

## Conventions

- Extensions are standalone .ts files; register tools at the top level of the extension function, not inside event handlers.
- Available imports: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `typebox`, plus deps in package.json (resolved from the global Pi install at runtime).
- Use `isToolCallEventType()` for type-safe `tool_call` event narrowing.
