# Usage

Day-to-day operation: starting peers, connecting to the deployed hub, addressing the fleet, and the knobs that change behavior. Prerequisites and first-time setup are in the repository `README.md`.

## Quick navigation

| Need to... | Run |
|------------|-----|
| Two peers on one machine | `just coms-net-server`, then `just coms --name a --cname a` and `just coms --name b --cname b` |
| Connect to the corp hub | SSM tunnel + token (see below) |
| List every just recipe | `just` |

Pi does not auto-load `.env`; the `just` recipes do (`set dotenv-load`). Running `pi` directly requires `source .env` first.

## Naming

The agent name flag is `--cname`; Pi owns `--name` and resumes it across sessions. The `just coms` recipe sets both from one value: the Pi session is named `<name> <timestamp>` so each run is traceable in Pi's session list, the coms identity is `<name>`, and `--explicit` keeps the operator out of peer auto-discovery. Extra args pass through to Pi.

```bash
just coms dev
just coms dev --model claude-opus-4-7
```

If the chosen name is already held by a live session, the hub assigns `name2` and the client adopts it -- check the widget or `coms_net_list` for the name you actually got. Peers address each other by exact name.

## Connecting to the corp hub

The hub is private; open an SSM port-forward first, then connect with your
personal token (one name per person -- names are exclusive addresses):

```bash
# terminal 1 -- the tunnel (dies with the SSO session)
aws ssm start-session --profile eu-shared-services-dev --region eu-central-1 \
  --target <hub-instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8787"],"localPortNumber":["8787"]}'

# terminal 2 -- the client
export PI_COMS_NET_SERVER_URL=http://127.0.0.1:8787
export PI_COMS_NET_AUTH_TOKEN=<your personal token>
just coms <you>
```

The hub instance id changes when the instance is replaced; find the current
one via the EC2 console or `tag:Name=pi-coms-hub-hub` (repo users can run
`just hub-tunnel`, which does the lookup automatically).

Operator sessions load `AGENTS.md` from the repo root -- the console scope
and synthesis rules. Personal tokens come from the directory
(`just token-create <principal> <names-csv>` for an admin; each operator
self-fetches their own SSM parameter).

## Speaking to the fleet

From any client session, natural language drives the tools:

- "ask eu-shared-services-dev how many RDS instances it sees" -- the model calls `coms_net_send` to that peer and `coms_net_await` for the reply.
- "ask everyone to summarize their environment" -- `coms_net_broadcast` fans out and returns each reply under its peer name.

Use an explicit verb ("ask ...", "send ... this:"). A bare `name:` prefix (`eu-oit-dev: what is running?`) is interpreted by the model, not parsed by the extension -- and smaller models misread it as an *incoming* message from that peer and answer locally without sending anything. Two ways to confirm a message really went out: the `coms_net_send` tool call renders in your session, and the hub log shows a `laptop → <peer>` line. Real inbound messages always carry the marker `[inbound coms-net message from <name> @ <path>]`; text without that marker did not come from a peer.

Replies to inbound messages are automatic: when a peer prompts your session, answer as a normal message. Never call `coms_net_send` to reply; the extension submits your turn output back to the caller.

### Durable sends

`coms_net_send` accepts `ttl_ms`. Beyond the 30-minute default the message is queued durably for an offline peer name and delivered when that name next registers (capped at 14 days by `PI_COMS_NET_MAX_TTL_MS`). Ask for it in natural language: "send eu-oit-dev a long-ttl message to run X when it comes back online".

## Talking to the monitor

Each AWS account also runs a monitor peer, `monitor-<alias>` (for example `monitor-eu-oit-dev`), registered `--explicit` -- invisible to `coms_net_list` and broadcasts unless you name it (or pass `include_explicit`). It answers a fixed command set without a model:

```
ask monitor-eu-oit-dev to run-checks     # run the check families now
... status                               # liveness, last run, unsent reports
... digest                               # current daily digest on demand
... history                              # last findings (7 days)
... suppressions                         # the suppression ledger
... suppress <pattern> | <reason>        # accept a known gap (LIKE pattern on dedup keys)
... unsuppress <pattern>                 # remove a ledger entry
```

Its incident reports and daily digest go to the `ops` duty name (`PI_MONITOR_REPORT_TO`) with a long TTL: they wait in the hub mailbox and appear as quiet one-line notices when a session holding that name connects -- never as a model turn. A quiet day still produces the digest -- silence past a day means the monitor itself is down, and a `DEGRADED` digest header means some check families errored. Details: [Monitoring](../architecture/monitoring.md).

Delivered reports stay readable: "show my inbox" or "show the ops inbox" calls `coms_net_inbox`, which lists retained mailbox messages non-destructively -- every operator sees the same history on demand, regardless of who received the push.

## In-session commands

| Command | Effect |
|---------|--------|
| `/coms-net` | Refresh the peer widget |
| `/coms-net --all` | Toggle showing `--explicit` peers |
| `/coms-net --project <name>` | Point the widget at another project |
| `/coms-net --reconnect` | Force SSE reconnect and re-register |
| `/coms-net --server` | Print hub URL, version, and `server_id` |

The widget below the editor shows each peer's name, model, live context usage bar, and purpose. A dim row is a stale peer; a crossed-out row is offline.

## Identity flags

Identity flags:

| Flag | Purpose |
|------|---------|
| `--cname <name>` | Registered peer name |
| `--purpose <text>` | Shown to peers in list output and the widget |
| `--project <name>` | Namespace; default `default`. Peers only see their own project |
| `--color <#RRGGBB>` | Widget color |
| `--explicit` | Hidden from lists and broadcasts unless explicitly requested |
| `--server-url`, `--auth-token` | Override env and local discovery |

Identity can also come from `--system-prompt`/`--append-system-prompt` markdown frontmatter (`name`, `description`, `color`); CLI flags win.

## Models

Always qualify models as `provider/id` -- `--model` matches a pattern, and a bare `gpt-5.4-mini` can fuzzy-match the wrong provider and fail with "No API key for provider". Pass `--model` through `just coms` to pin one per peer.

## Environment variables

Client-side knobs (defaults near the top of `extensions/coms-net.ts`):

| Variable | Default | Controls |
|----------|---------|----------|
| `PI_COMS_NET_SERVER_URL` | unset | Hub URL (else local `server.json` discovery) |
| `PI_COMS_NET_AUTH_TOKEN` | unset | Bearer token (else local `server.secret.json`) |
| `PI_COMS_NET_PROJECT` | unset | Project fallback when `--project` is not given |
| `PI_COMS_NET_MAX_HOPS` | `5` | Forwarding-chain ceiling |
| `PI_COMS_NET_MESSAGE_TTL_MS` | `1800000` | Await default and message expiry (30 min) |

Hub-side variables are covered in [Networking](../architecture/networking.md#hub-listeners-and-ports); the mailbox cap `PI_COMS_NET_MAX_TTL_MS` and every `PI_MONITOR_*` knob are tabulated in [Monitoring](../architecture/monitoring.md#configuration).

## Watching a cloud agent

```bash
# Attach to the remote agent's live terminal (SSH-over-SSM alias, user piagent)
herdr --remote pi-eu-shared-services-dev

# Or a plain shell on the host
aws ssm start-session --target <instance-id> --region eu-central-1 --profile <profile>
# then on the host:
sudo -u piagent -i herdr
```

Attach from a terminal outside any local Herdr session, treat the pane as read-only, and keep local and host Herdr versions matched.

## See Also

- [Communication](../architecture/communication.md) -- what the tools do underneath
- [Deployment](../deployment/deployment.md) -- standing up the hub and agents
- `README.md` -- prerequisites and quick starts
