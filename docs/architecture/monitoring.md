# Monitoring and the Hub Mailbox

Proactive monitoring of each AWS account by its own agent host, with durable delivery of reports to the operator. Two cooperating pieces, added together because one is useless without the other: the monitor detects issues on a schedule, and the hub mailbox guarantees its reports survive until the operator's next session -- the operator's laptop is usually offline when a check runs.

Design record: [`docs/superpowers/specs/2026-08-30-aws-monitor-design.md`](../superpowers/specs/2026-08-30-aws-monitor-design.md) (SIO-1575).

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

---

## The hub mailbox

The hub (`scripts/coms-net-server.ts`) stores messages in `bun:sqlite` at `~/.pi/coms-net/projects/<project>/messages.db` (WAL mode), write-through: creation inserts a row, every status transition updates it, the TTL sweep deletes terminal rows. The in-memory map stays the hot path; registry, SSE streams, and awaiters remain memory-only.

### Two TTLs

`POST /v1/messages` accepts an optional `ttl_ms`, capped by `PI_COMS_NET_MAX_TTL_MS` (default 7 days). The default TTL stays 30 minutes (`PI_COMS_NET_MESSAGE_TTL_MS`).

| Send | Target online | Target offline |
|------|---------------|----------------|
| Default / short `ttl_ms` | Delivered immediately | `target_not_found` (404), exactly as before |
| `ttl_ms` beyond the default | Delivered immediately, longer expiry | **Queued by name**: `200 {status: "queued", target_session: null}` |

A name-queued message is claimed by the next session that registers under that name (session ids change per connect, so the queue binds to the name, not a session). Interactive traffic keeps minutes; monitor reports use days.

### Flush on connect

When a session's SSE stream opens, the hub -- after `hello` and `pool_snapshot` -- claims any name-addressed mail for that session and flushes its queued messages oldest-first as ordinary `prompt` events. The client needs no changes to receive them: each flushed prompt triggers a normal follow-up turn, in queue order. The prompt's sender identity comes from values stored at send time, so it renders correctly even if the sender is long gone.

### Restart recovery

On boot the hub reloads all non-terminal messages from every project's `messages.db`. Delivered-but-unanswered mail is re-queued by name (at-least-once delivery: a peer that answered just as the hub died may see the prompt again). A new `server_id`, same mail. The hub container mounts a named volume (`coms-hub-mail` -> `/home/bun/.pi/coms-net`) so mail also survives container recreation.

### What changed about the hub's trust posture

The hub used to store nothing durable. It now persists **prompt and response bodies at rest** in `messages.db` until delivery plus sweep (up to 7 days for mailbox sends). See [Security Model](../security/security-model.md#hub-data-at-rest).

---

## The monitor

`scripts/coms-net-monitor.ts` runs as `pi-monitor.service` on every agent host, installed by the shared bootstrap. It sources `~/.coms-env`, so it sees the hub URL, token, `AWS_REGION`, and `AWS_ACCOUNT_ID`.

| Property | Value |
|----------|-------|
| Peer name | `monitor-aws-<account_id>`, registered `--explicit` (hidden from lists and broadcasts unless named) |
| Scheduling | In-process `Bun.cron()` (requires Bun >= 1.4): `*/15 * * * *` for alarms/logs/drift, `@daily` for cost + digest |
| State | `bun:sqlite` at `~/.pi/monitor/state.db`: watermarks, alert fingerprints, instance snapshots, cost history, journal, unsent-report queue |
| Model usage | None inside the monitor. Zero token spend when no findings |
| Modules | `scripts/monitor/checks/{alarms,logs,drift,cost}.ts`, `state.ts`, `report.ts`, `coms.ts` (headless coms-net client) |

### Checks

All checks are deterministic AWS SDK calls under the instance role, with clients injected for testability.

| Check | Cadence | Logic | Dedup |
|-------|---------|-------|-------|
| Alarms | 15 min | `DescribeAlarms`; transitions into ALARM (critical) / INSUFFICIENT_DATA (warn), recovery to OK (info) | Alarm name + state: a still-firing alarm alerts once, and only a state change re-arms it |
| Log errors | 15 min | `FilterLogEvents` since a per-group watermark, pattern `?ERROR ?WARN ?Exception`, grouped by a normalized message signature | Group + signature hash; re-alerts after 24 h |
| Drift/health | 15 min | Instance state changes vs the stored snapshot (stop/terminate = warn), failed status checks | Edge-triggered by the snapshot diff; status-check fingerprints clear on recovery |
| Cost | daily | Yesterday vs the trailing 14-day baseline; alerts only when over by **both** +20% and +$1 | Once per date |

Watermarks, fingerprints, and snapshots all persist in `state.db`, so a monitor restart produces neither duplicate nor missed alerts.

### Investigation

Findings of severity warn or critical go to the account's Pi agent (`aws-<account_id>`) as **one batched coms prompt per run**, carrying a `response_schema` for structured diagnoses (probable cause, affected resources, suggested action) and prior-incident context from the journal. Timeout 5 minutes, one attempt; on timeout or an unparseable reply the report ships with an "uninvestigated" marker. Detection never depends on the model.

### Reports

Both report kinds go to `PI_MONITOR_REPORT_TO` (default `laptop`) with a long TTL, so they wait in the hub mailbox when the operator is offline:

1. **Incident report** whenever a run has findings: severity-first summary, per-finding diagnosis and evidence. Recoveries ship as info.
2. **Daily digest** even when quiet: 24 h finding counts, check errors, current ALARM states, spend vs baseline. A missing digest is itself the monitor's dead-man signal.

If the hub is unreachable at report time, the report is queued in `state.db` and retried on the next tick -- the mailbox covers the offline-recipient half, this covers the offline-hub half.

### Commands

Any peer can prompt the monitor by name; it answers without a model:

| Command | Reply |
|---------|-------|
| `run-checks` | Runs the 15-minute check families now (guarded against overlapping with the cron run) |
| `status` | Liveness, last run, unsent report count |
| `digest` | The current digest, on demand |
| `history` | Last 20 journaled findings (7 days) |

```
ask monitor-aws-356994971776 to run-checks
```

### Configuration

Env-with-defaults; no config files. Set in the systemd unit environment or `~/.coms-env`.

| Variable | Default | Controls |
|----------|---------|----------|
| `PI_MONITOR_NAME` | `monitor-aws-<account_id>` | Peer name |
| `PI_MONITOR_REPORT_TO` | `laptop` | Report recipient (a peer name) |
| `PI_MONITOR_REPORT_TTL_MS` | `604800000` (7 d) | Mailbox TTL on reports |
| `PI_MONITOR_CHECK_CRON` | `*/15 * * * *` | Alarm/log/drift cadence |
| `PI_MONITOR_DAILY_CRON` | `@daily` | Cost check + digest (midnight UTC) |
| `PI_MONITOR_INVESTIGATE_TARGET` | `aws-<account_id>` | Peer that investigates findings |
| `PI_MONITOR_INVESTIGATE_TIMEOUT_MS` | `300000` (5 min) | Investigation deadline |
| `PI_MONITOR_COST_PCT` / `PI_MONITOR_COST_ABS` | `20` / `1` | Cost anomaly double threshold |
| `PI_MONITOR_STATE_DB` | `~/.pi/monitor/state.db` | State location |

Hub-side: `PI_COMS_NET_MAX_TTL_MS` (default `604800000`) caps any requested `ttl_ms`.

### IAM

Everything fits the existing role except the cost check: the module adds `ce:GetCostAndUsage` as the inline policy `cost-explorer-read` (`deploy/modules/agent/main.tf`). Cost Explorer is always called against `us-east-1`.

---

## Testing

`bun test` runs the repository's test suite (`tests/`): unit tests for every check family, monitor state, report formatting, and the run cycle (investigation fallback, unsent retry, overlap guard); integration tests that spawn the real hub as a subprocess with `HOME` in a temp dir to cover mailbox queueing, oldest-first flush, restart recovery, and the headless coms client end to end.

The manual end-to-end drill (force one finding per family on a live account, verify mailbox delivery and the digest) is documented in the plan: [`docs/superpowers/plans/2026-08-30-aws-monitor.md`](../superpowers/plans/2026-08-30-aws-monitor.md), Task 15.

## See Also

- [Communication](communication.md) -- the message lifecycle the mailbox extends
- [Networking](networking.md) -- endpoints and SSE events
- [Security Model](../security/security-model.md) -- what durable messages change
- [Deployment](../deployment/deployment.md) -- installing `pi-monitor.service`
