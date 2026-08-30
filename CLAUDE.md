# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# pi-coms

Peer-to-peer messaging between Pi Coding Agent instances (`coms` over Unix sockets, `coms-net` over HTTP/SSE) plus deployment: a zero-permission hub and one read-only Pi agent per AWS account.

## Commands

- Package manager: `bun` (not npm/yarn/pnpm). `bun install` to set up.
- Task runner: `just`; run `just` with no args to list recipes.
- Run a client: `just coms --name <n> --cname <n>` (coms-net) or `just local-coms --name <n>` (same-machine).
- Hub: `just coms-net-server` (localhost) or `just coms-net-server-lan` (requires `PI_COMS_NET_AUTH_TOKEN`).
- No test suite, linter, or build step; extensions load from source via Pi's jiti runtime. Syntax-check with `bun build extensions/<f>.ts --external '*' --outfile /dev/null`.
- Pi does not auto-load `.env`; `just` recipes do (`set dotenv-load`).

## Architecture

- `extensions/coms.ts` -- same-machine peers over Unix sockets; registry at `~/.pi/coms/`.
- `extensions/coms-net.ts` -- networked client. Hub is `scripts/coms-net-server.ts` (Bun HTTP/SSE, in-memory registry, cannot scale past one instance). Discovers `~/.pi/coms-net/projects/<project>/server.json` or takes `--server-url`/`--auth-token`. Agent name flag is `--cname` (Pi owns `--name`).
- Tool surface: `*_list`, `*_send`, `*_get`, `*_await`; coms-net adds `coms_net_broadcast` (fan-out to all/selected peers, replies gathered in parallel).
- Replies are automatic: an inbound prompt triggers a turn and the final assistant message is submitted back to the caller. Tools must never be used to reply (ping-pong loop guard is in the tool descriptions).
- Safety rails: hop limit (`PI_COMS*_MAX_HOPS`, default 5), audit log without prompt bodies, heartbeat/stale detection, localhost-only bind unless an auth token is set.
- `extensions/themeMap.ts` is a shared module (not an extension): every extension calls `applyExtensionDefaults(import.meta.url, ctx)` in `session_start`. Theme JSON lives in `~/.pi/agent/themes/`.

## Deployment (`deploy/`)

Star topology: the hub is a zero-permission relay; each AWS account is a spoke running its own agent with a `ViewOnlyAccess` instance role.

- `deploy/bootstrap/agent-bootstrap.sh` -- single shared bootstrap for every agent host, parameterized by `SECRETS_SOURCE=aws|file`. All install/launch logic lives here; shims only set env.
- `deploy/modules/agent/` -- Terraform module, applied once per AWS account (see `deploy/accounts/`).
- `deploy/hub/Dockerfile`, `deploy/hostinger/` -- the hub container and its VPS home.
- Agents clone `repo_url` at boot: deployment changes must be pushed before they take effect.

## Conventions

- Extensions are standalone .ts files; register tools at the top level of the extension function, not inside event handlers.
- Available imports: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, `@sinclair/typebox`, plus deps in package.json.
- Use `isToolCallEventType()` for type-safe `tool_call` event narrowing.
