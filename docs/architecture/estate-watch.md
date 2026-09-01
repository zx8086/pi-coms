# Estate Watch

How an agent living inside an AWS account, holding a read-only permission
surface, runs systematic periodic checks that everything is working.
Distilled from a production DevOps incident analyzer's runbooks and a year of
its operational memory, then adapted to this codebase. The generic doctrine
is kept here because it explains WHY the monitor is shaped the way it is;
each section names where the idea lives in this repository. Adopted 2026-09-01
(SIO-1591); implementation details in [Monitoring](monitoring.md).

## The premise shift: from incident-driven to standing watch

An incident agent is pull-triggered: a human describes a symptom and the
agent investigates from that anchor. A periodic watch inverts this -- no
symptom, no focus service, no time window is handed to you. Three things
change:

1. **You must manufacture your own anchors.** The incident agent's proven
   first move (alarms, Health events, core inventory before anything else)
   becomes the heartbeat. A standing watch is that discipline on a timer.
2. **Absolute state is nearly worthless; deltas are everything.** "There are
   28 alarms defined" means nothing. "Alarm X flipped to ALARM 40 minutes ago
   and was OK for 30 days" is the finding. Every check diffs against stored
   state (`~/.pi/monitor/state.db`: watermarks, fingerprints, snapshots).
3. **Alert fatigue is the failure mode.** An incident report is read once; a
   periodic report is read hundreds of times. Known, accepted imperfections
   must live in a ledger so they are never re-raised as fresh findings --
   that is the monitor's suppression ledger (`suppress <pattern> | <reason>`).

## What the permission surface affords -- and deliberately withholds

The corp role is the production incident analyzer's `DevOpsAgentReadOnly`
(base read policy + troubleshooting deep-dive policy, vendored verbatim in
`deploy/modules/agent/policies/`) plus named dev extensions. The watch is
designed around the walls, not surprised by them:

- **No writes, ever.** The agent observes and proposes; a human remediates.
  The watch is a smoke detector, not a sprinkler.
- **No secret values.** Secrets Manager and SSM are metadata-only, made
  structural by an explicit Deny (`SecretAndDataPlaneDeny`).
- **Log content is name-scoped.** A group outside the readable prefixes is a
  scoping fact to report, not a mystery.
- Field-proven quirks encoded in the spoke instructions
  (`deploy/AGENTS-spoke.md`): `logs:Describe*` list calls cannot be
  prefix-restricted; EC2 denies with `UnauthorizedOperation` while S3 uses
  bare `AccessDenied`; a denial probed against a fake resource id returns
  NotFound before IAM evaluation and proves nothing.

## The check ladder

Tiers, cheapest and most urgent first. A tier only earns its cost when the
tier above it is green -- there is no point checking log volumes while STS
itself is failing. Our mapping:

| Tier | Doctrine | Here | Cadence |
|---|---|---|---|
| T0 | Can I even see? Self-check before estate-check; a watch that silently loses access reports "all quiet" forever | Identity gate: `sts:GetCallerIdentity` vs `AWS_ACCOUNT_ID`, first in every cycle; critical on mismatch/denial and the cycle's checks are skipped. Capability canary = the bundle version in the daily digest | every cycle, first |
| T1 | Signal sweep: ride the platform team's alarm thresholds; Health events; core workload heartbeat | Alarms check (transitions only), drift/status checks; log error patterns | 15 min (`*/15`) |
| T2 | Find the outlier and the silence without enumerating | Ingestion heartbeat: Metrics Insights `IncomingLogEvents` per group vs a same-hour-of-day 7-day median -- a service whose log volume drops to zero has stopped logging or stopped running | hourly (`7 * * * *`) |
| T3 | Baseline and drift: audit trail alive, security findings, scary writes, spend | Cost anomaly (both +20% and +$1), trail status (`IsLogging`), cert expiry (<30 d warn, <7 d critical), CloudTrail write watchlist (StopLogging, SG ingress, IAM edits...) | daily (`@daily`) |
| T4 | Deep audit: network-path walks, IAM parity, retention posture | **Deferred** -- earned only once the false-positive rate of T0-T3 settles | -- |

Also deferred: Metrics Insights top-N fleet outliers (T2 doctrine; small
estates make per-resource checks sufficient) and Config inventory deltas
(Config enablement unconfirmed). The doctrine's own ordering applies: stand
up the cheap tiers, tune them, and let the false-positive rate tell you
whether the watch has earned more surface.

## Memory is the other half of the system

Durable, human-readable memory turns a stateless checker into a watch:

| Doctrine | Here |
|---|---|
| Baseline document (what normal looks like) | `state.db` snapshots, cost history, ingestion baselines; the deployment reference artifact for the estate itself |
| Known-gap ledger ("don't re-flag") | `suppressions` table; operator-owned, reasons required, journaled matches, footnote counts. The single most effective anti-fatigue device |
| Daily log and key decisions | The `journal` table (findings, check errors, runs; 90 d retention) plus the daily digest -- when a human asks "why did you page me", the answer is already written |
| Runbooks as skills | Diagnoses come from the account's Pi agent under `deploy/AGENTS-spoke.md` discipline, with prior-incident context injected from the journal |

## Field rules that keep the watch honest

Each rule exists because its absence produced a false report; they matter
more on a periodic watch, where a bad habit repeats every interval. All are
encoded in the spoke instructions the account agents load:

- **Grounded claims only.** Never report "not permitted" or "absent" unless
  a call in this run returned the error that proves it. The honest phrasing
  for something unchecked is "not inspected", never "not available".
- **Paginate before you conclude.** No counts or "all X" until every
  continuation token is walked; a size-truncation marker with no token means
  tighten the filter, never re-issue unchanged.
- **Relative time windows, deterministic guards.** A model computing
  absolute epochs will eventually send last year's date, and the resulting
  error reads exactly like "logs expired past retention". The monitor's own
  windows are computed in code; agents must query relative (`now-3h`).
- **Empty is not absent -- and absent is a finding.** Zero results plus a
  complete enumeration is a definitive negative: state it and stop. Zero
  results without the enumeration check is an unverified claim.
- **Budget every retry, change something each time.** Re-issuing an
  identical failed call is always wrong.
- **Know where your telemetry actually lives.** The monitor observing the
  account changes the account: its API calls echo into CloudTrail and
  `/aws/events/` log groups (excluded from scans by default). "No data in
  system X" is only an outage if the account is known to ship to system X.

## Reporting discipline

- Three verdict classes, never blurred: findings (evidence in hand), gaps
  (checked, with the observed error), not-inspected (out of scope this run).
- A green report produced while checks errored is a lie: the digest header
  flags `DEGRADED` with the check-error count.
- Delta-first: reports are edge-triggered findings, not inventories; the
  digest is the one standing summary and doubles as the dead-man signal.
- Escalation is the product. A read-only agent's output is a well-formed
  handoff: evidence chain, diagnosis, and a proposed -- human-gated --
  remediation. Recovery actions always require human approval.

## If we ask for more IAM

Already granted relative to the doctrine's wishlist: `ce:GetCostAndUsage`
(cost anomalies), `acm:List/DescribeCertificate` (cert expiry). Worth
considering later, all read-only: `support:DescribeTrustedAdvisorChecks`,
`backup:ListBackupJobs`/`ListRecoveryPoints`, `synthetics:DescribeCanaries`.
What not to ask for: writes. Self-healing destroys the trust model; when a
state change is evidence-supported, the correct move is a proposal.

## See Also

- [Monitoring](monitoring.md) -- the implementation: checks, ledger, mailbox
- [Security Model](../security/security-model.md) -- the permission surface
- `deploy/AGENTS-spoke.md` -- the investigation discipline agents load
