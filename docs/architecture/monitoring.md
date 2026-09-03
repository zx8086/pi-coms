# Monitoring and the Hub Mailbox

Proactive monitoring of each AWS account by its own agent host, with durable delivery of reports to the operator. Two cooperating pieces, added together because one is useless without the other: the monitor detects issues on a schedule, and the hub mailbox guarantees its reports survive until the operator's next session -- the operator's laptop is usually offline when a check runs.

Design record: [`docs/superpowers/specs/2026-08-30-aws-monitor-design.md`](../superpowers/specs/2026-08-30-aws-monitor-design.md) (SIO-1575).

```
+------------------+   15min/hourly/daily +------------------+
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

`POST /v1/messages` accepts an optional `ttl_ms`, capped by `PI_COMS_NET_MAX_TTL_MS` (default 14 days). The default TTL stays 30 minutes (`PI_COMS_NET_MESSAGE_TTL_MS`).

| Send | Target online | Target offline |
|------|---------------|----------------|
| Default / short `ttl_ms` | Delivered immediately | `target_not_found` (404), exactly as before |
| `ttl_ms` beyond the default | Delivered immediately, longer expiry | **Queued by name**: `200 {status: "queued", target_session: null}` |

A name-queued message is claimed by the next session that registers under that name (session ids change per connect, so the queue binds to the name, not a session). Interactive traffic keeps minutes; monitor reports use days.

### Flush on connect

When a session's SSE stream opens, the hub -- after `hello` and `pool_snapshot` -- claims any name-addressed mail for that session and flushes its queued messages oldest-first as `prompt` events flagged `mailbox: true`. Flushed mail does NOT trigger turns on the recipient (SIO-1579): the extension shows a passive notice per message and the operator reads the content on demand with `coms_net_inbox`. The prompt's sender identity comes from values stored at send time, so it renders correctly even if the sender is long gone.

### The durable inbox: read-many, on demand

Mailbox-class messages double as history. A terminal (delivered and answered, or expired-in-queue) mailbox message is retained in `messages.db` until its TTL expires, and `GET /v1/mailbox?name=<name>&limit=&since=<msg_id>` reads it back non-destructively — every operator sees the same list whenever they connect, with `since` as a stateless cursor (ULID ids sort by time). The client tool is `coms_net_inbox` (defaults to your own name; pass a shared name like `ops`). Short-TTL interactive messages never enter the inbox. Flush-on-connect still happens, but as quiet mailbox-flagged events -- the inbox is the read path, not the push.

### Restart recovery

On boot the hub reloads all non-terminal messages from every project's `messages.db`. Delivered-but-unanswered mail is re-queued by name (at-least-once delivery: a peer that answered just as the hub died may see the prompt again). A new `server_id`, same mail. The hub container mounts a named volume (`coms-hub-mail` -> `/home/bun/.pi/coms-net`) so mail also survives container recreation.

### What changed about the hub's trust posture

The hub used to store nothing durable. It now persists **prompt and response bodies at rest** in `messages.db` until delivery plus sweep (up to 14 days for mailbox sends). See [Security Model](../security/security-model.md#hub-data-at-rest).

---

## The monitor

`scripts/coms-net-monitor.ts` runs as `pi-monitor.service` on every agent host, installed by the shared bootstrap. It sources `~/.coms-env`, so it sees the hub URL, token, `AWS_REGION`, and `AWS_ACCOUNT_ID`.

| Property | Value |
|----------|-------|
| Peer name | Code default `monitor-aws-<account_id>`; the bootstrap sets `monitor-<alias>` (e.g. `monitor-eu-oit-dev`) on deployed hosts. Registered `--explicit` (hidden from lists and broadcasts unless named) |
| Scheduling | In-process `Bun.cron()` (requires Bun >= 1.4): `*/15 * * * *` for alarms/logs/drift, `7 * * * *` for the ingestion heartbeat (minute 7 keeps its guard off the */15 boundary), `@daily` for cost/trail/certs/watchlist + digest |
| State | `bun:sqlite` at `~/.pi/monitor/state.db`: watermarks, alert fingerprints, resource snapshots (instances, security groups, route tables, RDS, Lambda), cost history, journal, unsent-report queue |
| Model usage | None inside the monitor. Zero token spend when no findings |
| Modules | `scripts/monitor/checks/{alarms,logs,drift,resource-drift,cost}.ts`, `state.ts`, `report.ts`, `coms.ts` (headless coms-net client) |

### Checks

All checks are deterministic AWS SDK calls under the instance role, with clients injected for testability.

Every cycle starts with a T0 gate: `sts:GetCallerIdentity` compared against `AWS_ACCOUNT_ID`. A denial or account mismatch is a critical finding and skips the rest of that cycle's checks -- a monitor that silently loses access would otherwise report "all quiet" forever, and broken credentials would turn every check into correlated noise.

| Check | Cadence | Logic | Dedup |
|-------|---------|-------|-------|
| Identity (gate) | every cycle, first | `GetCallerIdentity`; mismatch or denial critical, recovery info | 24 h re-alert while broken; the gate skip continues even while deduped |
| Alarms | 15 min | `DescribeAlarms`; transitions into ALARM (critical) / INSUFFICIENT_DATA (info -- nightly scale-to-zero flaps these by design), recovery to OK (info) | Alarm name + state: a still-firing alarm alerts once, and only a state change re-arms it |
| Log errors | 15 min | `FilterLogEvents` since a per-group watermark, pattern `?ERROR ?Exception`, grouped by a normalized message signature (timestamps, UUIDs, hex, digits, and mixed-alphanumeric ids all collapse); capped at 3 signatures/group and 10 warn findings/cycle, overflow journaled as one info finding. A group denied by the name-scoped log IAM is one info scoping finding, and the scan continues | Group + signature hash; re-alerts after 24 h |
| Drift/health | 15 min | Instance state changes vs the stored snapshot (stop/terminate = warn), failed status checks | Edge-triggered by the snapshot diff; status-check fingerprints clear on recovery |
| Resource drift | 15 min | Snapshot diffs beyond instances (SIO-1597): security-group ingress+egress rules (change = warn), route-table routes (change = warn), RDS instance settings (public flip = critical, status = warn, class/version = info), Lambda config from one paginated `ListFunctions` (role = warn, rest info). New/deleted resources are info; a failing sub-scan is one fingerprinted info finding and the other scans still run | Edge-triggered by the snapshot diffs; scan-failure fingerprints clear on recovery |
| Cost | daily | Yesterday vs the trailing 14-day baseline; alerts only when over by **both** +20% and +$1 | Once per date |
| Ingestion | hourly | Metrics Insights `IncomingLogEvents` per log group; warn when the last full hour is 0 against a same-hour-of-day 7-day median >= 10 (so the nightly scale-to-zero is silent by construction); recovery info. The inverse of the log-errors check: it finds logging that **stopped** | Per group, alert once until recovery |
| Trail | daily | `GetTrailStatus` per trail: `IsLogging=false` critical, delivery error warn, zero trails info; recovery info. Shadow org trails that deny status reads are tolerated | Per trail + condition, 24 h re-alert |
| Certs | daily | ACM `NotAfter`: < 30 d warn, < 7 d critical (managed renewal happens ~60 d out, so < 30 d means renewal is failing). A cert whose domain is covered by another valid cert (exact or single-label wildcard, DomainName or SANs) reports `info` as superseded -- a rotated-out cert is cleanup noise, not risk | Per cert + severity, 7 d re-alert |
| Watchlist | daily | `cloudtrail:LookupEvents` for scary write events (StopLogging, SG ingress/egress and revocations, route changes, S3 exposure, IAM edits, ...); one call per event name, watermarked. `ModifyDBInstance` is deliberately absent: resource drift catches RDS changes within 15 minutes while this list runs daily. The monitor is read-only, so its own CloudTrail echo can never match | Per event id |

Watermarks, fingerprints, and snapshots all persist in `state.db`, so a monitor restart produces neither duplicate nor missed alerts.

### The suppression ledger

Operator-accepted imperfections (`suppress <pattern> | <reason>`) live in a `suppressions` table; patterns are SQL `LIKE` against `dedup_key`, so `alarm:%-Utilization-Low-20%` covers a whole alarm family. A matching finding is journaled (`suppressed_finding`), never investigated, and never in the report body -- the incident report carries a one-line footnote count and the digest a daily total. This is the anti-fatigue device: a periodic report is read hundreds of times, and known, accepted imperfections must not re-raise as fresh findings.

The counterweight is the scheduled suppression review (weekly by default): a mailed report listing every ledger entry with its reason, age, match count in the window, and sample dedup keys. Entries with zero matches are flagged as unsuppress candidates; a high-count entry is a prompt to re-examine what the pattern is actually eating. The same text is available on demand via the `review` command.

The agent module provisions one alarm itself -- `<name_prefix>-agent-status-check` (`StatusCheckFailed` on the agent host, no actions) -- so the alarm family always has a real signal even in an account with no other alarms: a degraded agent host becomes a critical incident report instead of silence.

### Investigation

Findings of severity warn or critical go to the account's Pi agent (`aws-<account_id>`) as **one batched coms prompt per run**, carrying a `response_schema` for structured diagnoses (probable cause, affected resources, suggested action) and prior-incident context from the journal. Timeout 5 minutes, one attempt; on timeout or an unparseable reply the report ships with an "uninvestigated" marker. Detection never depends on the model.

### Reports

Both report kinds go to `PI_MONITOR_REPORT_TO` (code default `laptop`; the bootstrap sets `ops` on deployed hosts) with a long TTL, so they wait in the hub mailbox when the operator is offline:

1. **Incident report** whenever a run has findings: severity-first summary, per-finding diagnosis and evidence. Recoveries ship as info.
2. **Daily digest** even when quiet: 24 h finding counts, each warn/critical finding of the window named on its own line (capped at 10, `[uninvestigated]`-tagged where the diagnosis failed, with an uninvestigated total -- counts alone hide what needs follow-up), check errors broken down by check family, current ALARM states, spend vs baseline, suppressed-finding count, and the deployed bundle version (the deploy canary: a stale bundle is visible without an SSM round-trip). When any check family errored in the window the header flags `DEGRADED` at `[warn]` -- a green digest produced over broken checks would be a lie. A missing digest is itself the monitor's dead-man signal.

If the hub is unreachable at report time, the report is queued in `state.db` and retried on the next tick -- the mailbox covers the offline-recipient half, this covers the offline-hub half.

### Commands

Any peer can prompt the monitor by name; it answers without a model:

| Command | Reply |
|---------|-------|
| `run-checks` | Runs the 15-minute check families now (guarded against overlapping with the cron run) |
| `status` | Liveness, last run, 24 h finding/suppressed/check-error counts, unsent report count |
| `digest` | The current digest, on demand |
| `review` | The suppression review, on demand |
| `history` | Last 20 journaled findings (7 days) |
| `suppressions` | The suppression ledger |
| `suppress <pattern> \| <reason>` | Add a ledger entry (`LIKE` pattern against dedup keys, reason required) |
| `unsuppress <pattern>` | Remove a ledger entry |

```
ask monitor-eu-oit-dev to run-checks
```

### Configuration

Env-with-defaults; no config files. Set in the systemd unit environment or `~/.coms-env`.

| Variable | Default | Controls |
|----------|---------|----------|
| `PI_MONITOR_NAME` | `monitor-aws-<account_id>` | Peer name |
| `PI_MONITOR_REPORT_TO` | `laptop` (bootstrap sets `ops`) | Report recipient (a peer name) |
| `PI_MONITOR_REPORT_TTL_MS` | `1209600000` (14 d) | Mailbox TTL on reports |
| `PI_MONITOR_CHECK_CRON` | `*/15 * * * *` | Alarm/log/drift cadence |
| `PI_MONITOR_HOURLY_CRON` | `7 * * * *` | Ingestion heartbeat (minute 7: never a */15 boundary) |
| `PI_MONITOR_DAILY_CRON` | `@daily` | Cost/trail/certs/watchlist + digest (midnight UTC) |
| `PI_MONITOR_REVIEW_CRON` | `@weekly` | Suppression review mail (monthly: `0 0 1 * *` + window 31) |
| `PI_MONITOR_REVIEW_WINDOW_DAYS` | `7` | Match window the review counts over |
| `PI_MONITOR_INVESTIGATE_TARGET` | `aws-<account_id>` | Peer that investigates findings |
| `PI_MONITOR_INVESTIGATE_TIMEOUT_MS` | `300000` (5 min) | Investigation deadline base |
| `PI_MONITOR_INVESTIGATE_PER_FINDING_MS` | `60000` (1 min) | Added to the deadline per finding in the batch |
| `PI_MONITOR_INVESTIGATE_MAX_MS` | `1800000` (30 min) | Deadline cap regardless of batch size |
| `PI_MONITOR_LOGS_FILTER` | `?ERROR ?Exception` | CloudWatch filter pattern (WARN deliberately absent) |
| `PI_MONITOR_LOGS_MAX_GROUPS` | `200` | Log-group scan cap (paginated, alphabetical) |
| `PI_MONITOR_LOGS_EXCLUDE` | `/aws/events/` (check default) | Comma-separated log-group name prefixes to skip; setting it replaces the default |
| `PI_MONITOR_JOURNAL_RETAIN_DAYS` | `90` | Journal history retention, pruned at the daily tick |
| `PI_MONITOR_INGEST_MIN_EVENTS` | `10` | Same-hour median floor below which a group never alerts on silence |
| `PI_MONITOR_WATCHLIST` | see `checks/watchlist.ts` | Comma-separated CloudTrail event names; setting it replaces the default |
| `PI_MONITOR_CERT_WARN_DAYS` / `PI_MONITOR_CERT_CRIT_DAYS` | `30` / `7` | Certificate expiry thresholds |
| `PI_MONITOR_COST_PCT` / `PI_MONITOR_COST_ABS` | `20` / `1` | Cost anomaly double threshold |
| `PI_MONITOR_STATE_DB` | `~/.pi/monitor/state.db` | State location |

Hub-side: `PI_COMS_NET_MAX_TTL_MS` (default `1209600000`, 14 days) caps any requested `ttl_ms`.

### IAM

Everything fits the existing role except two named additions in `deploy/modules/agent/main.tf`: `ce:GetCostAndUsage` (inline `cost-explorer-read`; Cost Explorer is always called against `us-east-1`) and `acm:ListCertificates`/`acm:DescribeCertificate` (`CertificateReads` in the dev-extensions policy) for the cert check. `sts:GetCallerIdentity` needs no grant; `cloudwatch:GetMetricData`, `cloudtrail:GetTrailStatus`, and `cloudtrail:LookupEvents` are already on the DevOpsAgentReadOnly policies.

---

## Testing

`bun test` runs the repository's test suite (`tests/`): unit tests for every check family, monitor state, report formatting, and the run cycle (investigation fallback, unsent retry, overlap guard); integration tests that spawn the real hub as a subprocess with `HOME` in a temp dir to cover mailbox queueing, oldest-first flush, restart recovery, and the headless coms client end to end.

The manual end-to-end drill (force one finding per family on a live account, verify mailbox delivery and the digest) is documented in the plan: [`docs/superpowers/plans/2026-08-30-aws-monitor.md`](../superpowers/plans/2026-08-30-aws-monitor.md), Task 15.

## See Also

- [Communication](communication.md) -- the message lifecycle the mailbox extends
- [Networking](networking.md) -- endpoints and SSE events
- [Security Model](../security/security-model.md) -- what durable messages change
- [Deployment](../deployment/deployment.md) -- installing `pi-monitor.service`
