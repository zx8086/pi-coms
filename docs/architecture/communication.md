# Communication

The message model shared by both transports: how a prompt travels, how replies come back automatically, and the rails that keep agent-to-agent conversation from looping. Tool names below use the `coms_net_*` form; the `coms_*` equivalents behave the same unless a difference is called out.

## Tool surface

| Tool | Parameters | Behavior |
|------|-----------|----------|
| `coms_net_list` | `project?`, `include_explicit?` | List peers with name, purpose, model, live context usage, status |
| `coms_net_send` | `target`, `prompt`, `conversation_id?`, `response_schema?`, `ttl_ms?` | Send a prompt to one peer; returns `msg_id` on ack. A `ttl_ms` beyond the 30-minute default makes the send durable (see Mailbox below) |
| `coms_net_get` | `msg_id` | Non-blocking status poll: `pending`, `complete`, `error`, `timeout` |
| `coms_net_await` | `msg_id`, `timeout_ms?` | Block until the reply lands or the timeout fires |
| `coms_net_broadcast` | `prompt`, `targets?`, `timeout_ms?` | Fan out to all (or selected) peers; replies gathered in parallel |
| `coms_net_inbox` | `name?`, `limit?`, `since?`, `msg_id?` | Read a durable inbox non-destructively: retained mailbox messages, identical for every reader. Listing bodies are 2000-char previews; `msg_id` returns one message in full (see [Monitoring](monitoring.md#the-durable-inbox-read-many-on-demand)) |

`coms_net_broadcast` exists only on the networked transport. `target` is a peer name in the caller's project, or a session id. When a name maps to more than one live session, the hub rejects the send with `ambiguous_target` rather than guessing.

## Message lifecycle

States: `queued`, `delivered`, `complete`, `error`, `timeout` (`scripts/coms-net-server.ts:133-138`). There is deliberately no `in_progress` state.

```
+--------+  target SSE open  +-----------+  reply submitted  +----------+
| queued | ----------------> | delivered | ----------------> | complete |
+--------+                   +-----------+                   +----------+
    |                              |                              or
    |         TTL (30 min) expires |                         +----------+
    +------------------------------+-----------------------> |  error   |
                                                             +----------+
```

1. **Send.** `coms_net_send` posts to `/v1/messages`. The hub resolves the target, checks the hop count and the target's inbox depth (cap 100), assigns a ULID `msg_id`, and pushes a `prompt` event down the target's SSE stream. The sender gets the `msg_id` back immediately.
2. **Deliver.** The receiving extension injects the prompt into its session as a follow-up message that triggers a normal Pi turn (`extensions/coms-net.ts:657-714`). The injected text names the sender and its working directory.
3. **Reply.** On `agent_end`, the extension takes the final assistant message of that turn and submits it via `POST /v1/messages/:id/response` (`extensions/coms-net.ts:1650-1707`). The hub pushes a `response` event to the sender and releases any awaiters.
4. **Collect.** The sender's `coms_net_await` races three sources: the local SSE-resolved promise, a server long-poll on `/v1/messages/:id/await`, and a local timer (`extensions/coms-net.ts:1437`).

Messages expire 30 minutes after creation by default (`PI_COMS_NET_MESSAGE_TTL_MS`); expired queued or delivered messages become `error: "expired"`. A send may request a longer `ttl_ms`, capped by `PI_COMS_NET_MAX_TTL_MS` (default 14 days).

### Mailbox: durable sends to offline peers

A send whose `ttl_ms` exceeds the default is a **mailbox send**. If the target name has no live session, the hub does not return `target_not_found`; it queues the message by name (`200 {status: "queued", target_session: null}`) and persists it in sqlite. The next session registering under that name receives all its queued mail oldest-first as `prompt` events flagged `mailbox: true`, right after `hello` and `pool_snapshot` on its SSE stream. Mailbox-flagged prompts never trigger a turn on the recipient: the extension shows a passive notice and the content is read on demand with `coms_net_inbox` (the hub inbox retains it until TTL expiry). Only interactive short-TTL sends trigger turns and auto-replies. Queued mail survives hub restarts and container recreation. Short-TTL interactive sends keep the fail-fast behavior exactly as before.

This is how monitor reports reach an operator whose laptop was offline at check time. Full mechanics in [Monitoring](monitoring.md#the-hub-mailbox).

### Target death fails pending replies fast

When an agent leaves the hub for any reason (clean shutdown, stale eviction, token revocation), every message that was **delivered** to it but not yet answered is failed terminally with `error: "target_died"`. The sender's SSE stream gets a `response` event carrying the msg_id and the unregister reason, and any pending `coms_net_await` on that id resolves immediately instead of hanging until its timeout -- an in-flight turn does not survive the agent's death, so there is nothing to wait for. **Queued** (never-delivered) mailbox mail is untouched: it keeps store-and-forward semantics and still flushes to the name's next session.

### Replies are automatic -- never a tool call

The receiver must not call `coms_net_send` to answer an inbound prompt; its turn output is the answer. This rule is enforced three ways:

1. The injected inbound message carries an explicit guard: "reply by writing a normal assistant message ... DO NOT call coms_net_send/coms_net_await/coms_net_get to reply; that creates a ping-pong loop" (`extensions/coms-net.ts:685-688`).
2. Every send-family tool description repeats the warning.
3. The hop limit (below) backstops both.

The local `coms` transport relies on the hop counter alone; its inbound injection carries no guard text.

### Structured replies

`response_schema` requests a JSON reply. The receiving extension parses the final assistant message as JSON and returns a parse failure as `error: "response not valid JSON"`; it checks parseability only, not conformance to the schema.

## Broadcast

`coms_net_broadcast` (`extensions/coms-net.ts:1505-1646`):

1. Resolves targets: the explicit `targets` list, or every peer in the project that is not `offline` (stale peers are included).
2. Fans out one independent `/v1/messages` send per target in parallel. A per-target send failure becomes that target's result; it never fails the whole broadcast.
3. Gathers all replies in parallel with a **per-peer** timeout, so wall-clock time is bounded by the slowest peer, not the sum.
4. Returns `<replied>/<total>` with each reply (or error) under its peer name.

## Safety rails

| Rail | Mechanism | Default |
|------|-----------|---------|
| Hop limit | `hops` increments when a send happens inside an inbound-triggered turn; sends at the ceiling are rejected by client and hub | 5 (`PI_COMS_NET_MAX_HOPS` / `PI_COMS_MAX_HOPS`) |
| Ping-pong guard | Injected guard text plus tool-description warnings (coms-net) | -- |
| Inbox cap | Hub rejects sends when the target has 100 undelivered or unanswered messages | `PI_COMS_NET_MAX_INBOX` |
| Message TTL | Undelivered or unanswered messages expire | 30 min (`PI_COMS_NET_MESSAGE_TTL_MS`); per-send `ttl_ms` capped at 14 d (`PI_COMS_NET_MAX_TTL_MS`) |
| Audit log | Every send/receive/response logged with `msg_id`, names, hops -- never prompt or response bodies | -- |

A fresh user-initiated send starts at `hops = 0`. A send made while answering an inbound message inherits `inbound.hops + 1` (`extensions/coms-net.ts:1208-1211`), so a forwarding chain dies after five hosts no matter what the models decide to do.

## Audit logs

Both extensions append structured entries to the Pi session log: `coms-log` and `coms-net-log`. Logged: boot and shutdown, registration and name collisions, `prompt_in`/`prompt_out`, `response_in`/`response_out`, SSE connect/disconnect/reconnect, failures. Never logged: prompt text, response bodies, auth tokens. The hub additionally logs to stdout with prompt previews truncated to 47 characters.

## See Also

- [Networking](networking.md) -- the endpoints and SSE events beneath these semantics
- [Monitoring](monitoring.md) -- the mailbox in detail, and the monitor that relies on it
- [System Overview](overview.md)
- [Usage](../development/usage.md) -- addressing the fleet in practice
