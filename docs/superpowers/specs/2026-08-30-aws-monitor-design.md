# AWS Account Monitor and Hub Mailbox -- Design

Date: 2026-08-30
Status: Approved in design review (chat); pending spec review

## Goal

Proactive monitoring of each AWS account by its agent host: scheduled deterministic checks detect issues, the account's Pi agent investigates them with its model, and reports reach the operator durably -- even though the operator's laptop session is usually offline when a check runs.

Two subsystems:

1. **Hub mailbox** -- store-and-forward for coms-net messages, closing the existing gap where messages queued for an offline peer expire undelivered.
2. **Monitor** -- a long-running Bun process per agent host that runs scheduled checks, delegates diagnosis to the Pi agent, and mails reports to the operator.

## Decisions made in review

| Decision | Choice |
|----------|--------|
| Findings sink | Hub store-and-forward (mailbox), not external alerting |
| Check scope | Alarms, log errors, drift/health, cost anomalies -- all four |
| Cadence | 15-minute checks; daily digest even when quiet |
| Scheduling | In-process `Bun.cron()` inside a persistent monitor process; no systemd timers, no crontab |
| Persistence | `bun:sqlite` for both hub mailbox and monitor state |
| Incident memory | KISS: monitor's local journal, fed into investigation prompts. No Couchbase agent-memory now; revisit for fleet-wide recall |

## Architecture

```
+------------------+     15min/daily      +------------------+
|  pi-monitor      | -- Bun.cron ticks -->|  checks (AWS SDK)|
|  (Bun process,   |                      +---------+--------+
|  coms-net peer)  |                                | Finding[]
+---+----------+---+                                v
    |          |                          +------------------+
    |          +--- coms send ----------->|  Pi agent        |
    |             "investigate" (batched) |  (model, tools)  |
    |          +--- auto-reply -----------+------------------+
    |          v
    |   report = findings + diagnosis
    |
    +--- coms send, ttl=days ---> hub mailbox (sqlite) ---> operator's
                                                            next session
```

The monitor and the Pi agent are separate processes on the same host. A wedged agent never stops detection; a crashed monitor (restarted by systemd) never touches the agent.

## Subsystem 1: hub mailbox

`scripts/coms-net-server.ts` gains durability for messages only. Registry, streams, and awaiters stay in-memory.

1. **Storage**: `bun:sqlite` at `~/.pi/coms-net/projects/<project>/messages.db`, WAL mode. Write-through: message creation inserts a row; every status transition updates it. The in-memory map remains the hot path.
2. **Deliver on connect**: when a session's SSE stream opens, after `hello` and `pool_snapshot`, flush that session's `queued` messages oldest-first. Today the hub only pushes prompts down streams open at send time; queued messages die (`scripts/coms-net-server.ts:660-740` sends no queue flush).
3. **Restart recovery**: on boot, load non-terminal messages into memory. New `server_id`, same mail.
4. **Two TTLs**: default stays 30 minutes (`PI_COMS_NET_MESSAGE_TTL_MS`). `/v1/messages` accepts optional `ttl_ms`, capped by new `PI_COMS_NET_MAX_TTL_MS` (default 7 days). Monitor reports use days; interactive traffic keeps minutes.
5. **Name-addressed delivery**: sends may target an offline name. Today that fails with `target_not_found`; with the mailbox, a send carrying `ttl_ms` beyond the default queues by name (`target_session` null until claimed) and is delivered to the next session registering as that name (session ids change per connect). Short-TTL interactive sends keep today's fail-fast behavior. Trust model unchanged: one token, names as addresses, now extended over time.
6. **Cleanup**: terminal rows deleted on the existing sweep cadence.
7. **Container**: the hub's compose gains a volume for `messages.db` so mail survives container recreation.

Client change in `extensions/coms-net.ts`: pass through optional `ttl_ms` on send; verify flushed-on-connect prompts are handled in order (they arrive as normal `prompt` events).

## Subsystem 2: monitor

`scripts/coms-net-monitor.ts`, run as `pi-monitor.service` (systemd, installed by `deploy/bootstrap/agent-bootstrap.sh`, sourcing `~/.coms-env`).

1. **Schedules**: in-process `Bun.cron()` -- `*/15 * * * *` for alarms/logs/drift, `@daily` for cost and digest. Bun's no-overlap guarantee prevents stacked runs.
2. **Coms identity**: registers as `monitor-aws-<account_id>`, explicit (hidden from lists/broadcasts unless named). Inbound prompts match a small command set -- `run-checks`, `status`, `digest`, `history` -- no model inside the monitor.
3. **State**: `bun:sqlite` at `~/.pi/monitor/state.db`, WAL: per-log-group watermarks, finding fingerprints (dedup), cost baseline, run/finding journal.
4. **Checks**: deterministic AWS SDK calls under the instance role; zero tokens when quiet.

| Check | Cadence | Logic | Dedup key |
|-------|---------|-------|-----------|
| Alarms | 15 min | `DescribeAlarms`; transitions into ALARM/INSUFFICIENT_DATA and recovery to OK | alarm name + state |
| Log errors | 15 min | `FilterLogEvents` since watermark, `?ERROR ?WARN ?Exception`, grouped by log group | group + signature hash |
| Drift/health | 15 min | Instance state changes vs snapshot, failed status checks, stopped instances | resource id + condition |
| Cost | daily | Yesterday vs trailing 14-day baseline; alert only when over by both 20% and $1 | date |

5. **Finding**: typed record -- severity (`info`/`warn`/`critical`), family, resource, summary, raw evidence. Zod-validated before leaving the monitor.
6. **Investigation**: findings `warn`+ go to the account's Pi agent as one batched prompt per run, with a `response_schema` for structured diagnosis (probable cause, affected resources, suggested action) and prior-incident context from the journal ("previously seen <date>, diagnosis was ..."). Timeout 5 minutes, one attempt; on timeout or parse failure the report ships uninvestigated -- detection never depends on the model.
7. **Reports** to `PI_MONITOR_REPORT_TO` (default `laptop`), long TTL:
   - **Incident report** on any findings: findings + diagnosis, severity first line. Recoveries ship as `info`.
   - **Daily digest** even when quiet: 24h counts, current ALARM states, spend vs baseline. A missing digest is itself the monitor's dead-man signal.

## IAM

Add `ce:GetCostAndUsage` to the agent role's inline policy (`deploy/modules/agent/main.tf`). All other checks fit the existing ViewOnlyAccess + CloudWatch inline grants.

## Files

| File | Change |
|------|--------|
| `scripts/coms-net-monitor.ts` | New: monitor process |
| `scripts/monitor/checks/{alarms,logs,drift,cost}.ts` | New: one module per family, AWS client injected |
| `scripts/monitor/state.ts` | New: sqlite journal, watermarks, dedup, baselines |
| `scripts/monitor/report.ts` | New: Zod types, digest assembly |
| `scripts/coms-net-server.ts` | Mailbox: write-through, flush-on-connect, `ttl_ms`, recovery |
| `extensions/coms-net.ts` | `ttl_ms` pass-through; verify flush ordering |
| `deploy/bootstrap/agent-bootstrap.sh` | Install `pi-monitor.service` |
| `deploy/modules/agent/main.tf` | `ce:GetCostAndUsage` |
| `deploy/hostinger/docker-compose.yml` | Volume for `messages.db` |

Configuration is env-with-defaults: cadences, digest hour, cost thresholds, `PI_MONITOR_REPORT_TO`, investigation timeout. No new config files.

## Error handling

1. Check failure (API throttle, network): logged to the journal, run continues with remaining checks; repeated failures of one family appear in the digest.
2. Investigation timeout/parse failure: report ships uninvestigated with a marker.
3. Hub unreachable at report time: report rows persist in monitor state as unsent; retried next tick (mailbox handles the offline-recipient half; this handles the offline-hub half).
4. Monitor crash: systemd restarts; watermarks and dedup prevent duplicate or missed alerts across the restart.

## Testing

`bun test` (first test suite in the repo; local runs, no CI wiring in scope):

1. **Checks (unit)**: fake AWS clients; transition detection, watermark advance, dedup, drift diffing, cost double-threshold.
2. **State (unit)**: in-memory sqlite; persistence, expiry, history lookup.
3. **Mailbox (integration)**: real server, OS port, temp dirs -- queue then flush on SSE open oldest-first; restart recovery; differential TTL expiry.
4. **Scheduling (unit)**: fake timers drive `Bun.cron`; one run per boundary, no overlap under slow handlers.
5. **End-to-end (manual, poc account)**: force one finding per family (test alarm, ERROR log line, stopped scratch instance); verify incident report and digest arrive in the mailbox.

Verification: `bun test`; syntax checks via `bun build <file> --external '*' --outfile /dev/null` for touched extension/server files.

## Out of scope

- CI wiring for the test suite
- Couchbase agent-memory integration (revisit for fleet-wide recall)
- Per-peer authorization on the hub
- Remediation actions (the role stays read-only; the monitor reports, never fixes)
- Windows support for the monitor (agent hosts are Linux)
