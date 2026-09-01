# Estate Watch adoptions for the monitor

Adopt the checks and disciplines from the Estate Watch distillation (DevOps
Incident Analyzer runbooks) that our monitor lacks. All detection stays
deterministic (no model in the monitor), all IAM stays read-only.

## Scope

Approved by the operator 2026-09-01. New deps approved: `@aws-sdk/client-sts`,
`@aws-sdk/client-cloudtrail`, `@aws-sdk/client-acm`.

- A1 suppression ledger: operator-accepted known gaps stop re-raising.
- A2 T0 identity gate + bundle-version canary in the digest.
- A3 log ingestion heartbeat (silence detection), hourly.
- A4 CloudTrail trail-status check, daily.
- A5 ACM certificate expiry check, daily (needs `acm:List/DescribeCertificate`
  in the dev-extensions inline policy).
- A6 degraded digest marker when check families errored.
- A7 CloudTrail write-event watchlist, daily.
- A12 telemetry-topology note in the spoke instructions.

Deferred: T2 fleet top-N outliers, T4 deep audits, Config inventory deltas
(Config enablement unconfirmed). A8-A11 already exist in
`deploy/AGENTS-spoke.md`.

## Scheduling (tier mapping)

| Cron | Tier | Checks |
|---|---|---|
| `*/15 * * * *` (existing `PI_MONITOR_CHECK_CRON`) | T0 + T1 | identity gate first, then alarms, logs, drift |
| `7 * * * *` (new `PI_MONITOR_HOURLY_CRON`) | T2 | ingestion heartbeat (minute 7 deliberately off the */15 boundary so guards never collide) |
| `@daily` (existing `PI_MONITOR_DAILY_CRON`) | T3 | cost, trail status, cert expiry, watchlist, digest, journal prune |

Tier gating: only T0 gates. A critical identity finding skips the rest of that
cycle's checks (they would all error into noise) and ships as its own critical
report. The hourly and daily cycles carry the same gate.

## Design

### Identity gate (`checks/identity.ts`)

`sts:GetCallerIdentity` (no IAM grant needed). Mismatch vs `AWS_ACCOUNT_ID`
or a thrown call is critical, dedup with 24 h re-alert; success after a
failure ships an info recovery and clears the fingerprint. `runCycle` gains
an optional `gate` check that runs first and, on any critical finding,
suppresses the `checks` array for that cycle.

### Suppression ledger (`state.ts` + cycle + commands)

New table `suppressions (pattern PRIMARY KEY, reason, created_at)`; matching
is SQL `LIKE` against `dedup_key` (so `alarm:%-Utilization-Low-20%` covers
the flapping family). Suppressed findings are journaled
(`suppressed_finding`), never investigated, never in the report body; the
incident report carries a one-line footnote count. New monitor commands:
`suppress <pattern> | <reason>`, `unsuppress <pattern>`, `suppressions`.

### Ingestion heartbeat (`checks/ingestion.ts`)

One Metrics Insights `GetMetricData` call:
`SELECT SUM(IncomingLogEvents) FROM SCHEMA("AWS/Logs", LogGroupName) GROUP BY
LogGroupName ORDER BY SUM() DESC LIMIT 500`, hourly period, window now-8d.
Per group: observed = last full hour; baseline = median of the same
hour-of-day over the prior 7 days. Warn when baseline >=
`PI_MONITOR_INGEST_MIN_EVENTS` (default 10) and observed = 0; recovery info
when ingestion resumes. The same-hour baseline makes the nightly
scale-to-zero silent by construction. Honors the logs-check exclude prefixes.

### Trail status (`checks/trail.ts`)

`DescribeTrails` + `GetTrailStatus` per trail. `IsLogging=false` critical,
`LatestDeliveryError` warn, zero trails info once; recovery clears. Per-trail
errors are tolerated unless every trail fails (then the check errors).

### Cert expiry (`checks/certs.ts`)

`ListCertificates` (paginated) + `DescribeCertificate`. NotAfter < 30 d warn,
< 7 d critical (ACM-managed certs renew ~60 d out, so < 30 d means renewal is
failing); 7 d re-alert while the condition holds. IAM: new `CertificateReads`
Sid in `devops_readonly_dev_extensions` (inline policy change, no instance
replacement).

### Write watchlist (`checks/watchlist.ts`)

One `LookupEvents` call per watched EventName (the API takes one attribute
per call), sequential, watermarked; first run looks back 24 h. Dedup by event
id, watermark advances only after a fully successful pass. Default list
(override `PI_MONITOR_WATCHLIST`): StopLogging, DeleteTrail, UpdateTrail,
PutBucketPolicy, PutBucketAcl, AuthorizeSecurityGroupIngress, CreateUser,
CreateAccessKey, AttachUserPolicy, AttachRolePolicy, PutRolePolicy,
PutUserPolicy, DeleteFlowLogs. Warn each. The monitor is read-only so its own
CloudTrail echo can never match a write watchlist.

### Digest (`report.ts`)

Header becomes `[warn] ... daily digest (DEGRADED: N check error(s))` when
any check family errored in the window; new lines for bundle version (read
from `.bundle-version`, "unknown" in dev) and suppressed-finding count.

### Families

`FamilySchema` gains `identity`, `ingestion`, `trail`, `cert`, `watchlist`.

## Files

| File | Change |
|---|---|
| `package.json` | + client-sts, client-cloudtrail, client-acm |
| `scripts/monitor/checks/{identity,ingestion,trail,certs,watchlist}.ts` | new checks |
| `scripts/monitor/state.ts` | suppressions table + API |
| `scripts/monitor/report.ts` | families, footnote, degraded digest, bundle line |
| `scripts/coms-net-monitor.ts` | gate in runCycle, suppression filter, hourly cron + guard, daily checks, commands, env |
| `deploy/modules/agent/main.tf` | CertificateReads Sid in dev-extensions |
| `deploy/AGENTS-spoke.md` | telemetry-topology section (A12) |
| `AGENTS.md` | new monitor commands, ledger + degraded-digest semantics |
| `docs/architecture/monitoring.md` | checks/cadence/config/command tables |
| `tests/checks-{identity,ingestion,trail,certs,watchlist}.test.ts`, `tests/state.test.ts`, `tests/report.test.ts`, `tests/monitor-cycle.test.ts` | coverage |

## Verification

```bash
bun test                                   # all pass, new suites included
bun build extensions/coms-net.ts --external '*' --outfile /dev/null
cd deploy/accounts/eu-shared-services-dev && terraform plan   # inline policy update only, NO replacement
```

## Out of scope

Fleet deploy of the result (separate step: merge to main, publish bundle,
SSM re-run), T2/T4 tiers, Config-based inventory deltas, any write IAM.
