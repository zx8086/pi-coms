# Handover -- ops-inbox blind spots arc, SIO-1601..1605 (all Done)

- **Date:** 2026-09-03
- **Tickets (all Done, all rolled out):**
  - [SIO-1601](https://linear.app/siobytes/issue/SIO-1601) -- digest names warn+ findings; inbox review protocol. PR #56.
  - [SIO-1602](https://linear.app/siobytes/issue/SIO-1602) -- inbox previews 2000 chars, `msg_id` full-body read. PR #58.
  - [SIO-1603](https://linear.app/siobytes/issue/SIO-1603) -- cert check recognizes renewed replacement certs. PR #59.
  - [SIO-1604](https://linear.app/siobytes/issue/SIO-1604) -- scheduled suppression review report. PR #60.
  - [SIO-1605](https://linear.app/siobytes/issue/SIO-1605) -- cert check scans multiple ACM regions. PR #61.
  - (No ticket) PR #57 -- AGENTS.md operator-console review pass.
- **Repo state:** `main` @ `0122280`. Working tree clean (untracked `guides/` is a Stow symlink, never commit).
- **Fleet:** both spokes on bundle `0122280`, all five fixes live. `bun test`: 187 pass.
- This is a reference + watch-list doc, not a pick-up-the-work handover. No open implementation work.

## TL;DR

One operator complaint drove the whole day: an ops-inbox review reported digests
side by side but silently dropped `cert=2` and `drift=3`, and the cert details
took three more turns to recover. Root causes were fixed at every layer: the
digest now names its warn+ findings; the inbox tool no longer truncates reports
into unreadability and can fetch one message in full; the cert check stops
crying critical about certs that were already renewed, and now sees us-east-1;
the suppression ledger gets a weekly anti-masking review. The review's first
live run immediately caught a broken ledger entry (a pattern that could never
match) on both accounts; it was corrected, and the quiet MSK pattern was
unsuppressed on shared.

## Context -- how this arc came to be

The operator asked why an inbox summary had to be chased for certificate and
drift detail ("the summary of the ops inbox should not leave things out that
need follow up"). Investigation traced four independent mechanisms, each
ticketed and fixed the same day. Originating conversation facts are recorded in
the ticket Problem sections; the arc supersedes nothing -- it builds on
`experiments/HANDOFF-2026-09-02-coms-net-fixes-1598-1599-1600.md` (note: that
file lives on the unmerged branch `simonowusupvh/handoff-coms-net-fixes`).

## What shipped, where the code is

| Change | Code | Tests |
|---|---|---|
| Digest notables: each warn/critical finding of the last 24 h on its own line, critical first, cap 10 + overflow, `[uninvestigated]` markers, `uninvestigated: N` total; info findings counts-only; quiet digest byte-identical | `scripts/monitor/report.ts` (`notablesFromJournal`, `formatDigest`), wired in `buildDigest` (`scripts/coms-net-monitor.ts`) | `tests/report.test.ts` "digest notables" |
| Inbox: listing previews 400 -> 2000 chars; `coms_net_inbox` gains `msg_id` (full untruncated body, fetch widens to server cap 100); miss names the id | `extensions/inboxFormat.ts` (`formatInbox`), `extensions/coms-net.ts` inbox tool | `tests/inbox-format.test.ts` |
| Cert supersession: an expiring cert covered by another valid cert in the SAME region (exact / single-label wildcard, DomainName or SANs) reports `info` with `evidence.supersededBy` | `scripts/monitor/checks/certs.ts` (`covers`, successor search) | `tests/checks-certs.test.ts` "supersession" |
| Cert multi-region: per-region ACM clients (default host region + `us-east-1`; `PI_MONITOR_CERT_REGIONS`); region in summary + evidence; unreadable region = one info scoping finding, others continue | `scripts/monitor/checks/certs.ts` (`certRegions`, `RegionalAcm`), clients built in `scripts/coms-net-monitor.ts` | `tests/checks-certs.test.ts` "multi-region", "certRegions" |
| Suppression review: weekly mail (`PI_MONITOR_REVIEW_CRON` default `@weekly`, window `PI_MONITOR_REVIEW_WINDOW_DAYS` default 7) listing every ledger entry with match count + <=3 sample keys; 0 matches flagged "candidate for unsuppress"; on-demand `review` command | `scripts/monitor/report.ts` (`suppressionReviewFromJournal`, `formatSuppressionReview`), cron + command in `scripts/coms-net-monitor.ts` | `tests/report.test.ts` "suppression review" |
| Operator rules: review protocol (enumerate every nonzero family, name warn+ findings, quote `uninvestigated:` verbatim); `…`-cut bodies re-read via `msg_id`; identity = hub attribution; `coms_net_list` no-arg; await timeouts in minutes; suppression-review reading rule | `AGENTS.md` | -- |

Docs updated alongside: `docs/architecture/monitoring.md` (digest, cert row,
review, env vars), `docs/architecture/communication.md` (inbox tool row).

## Operational changes made live (not in git)

- Both ledgers had entry `Statistics Service Alarm` (added 2026-09-02) -- a
  bare alarm name, no `alarm:` prefix / `:%` suffix, so it could NEVER match a
  dedup key. Caught by the first live `review`. Replaced on BOTH monitors with
  `alarm:Statistics Service Alarm:%` (original reason kept, correction noted).
  The alarm really is named `Statistics Service Alarm` -- key seen in history:
  `alarm:Statistics Service Alarm:INSUFFICIENT_DATA`.
- `logs:/aws/msk/brokers:%` unsuppressed on shared-services (0 matches in 7 d;
  operator decision). If MSK rebalance chatter recurs it reports fresh; the
  re-suppress command is in the ledger docs.
- Shared ledger now: Low-20 alarms, 3 Confluent phone-home signatures,
  corrected Statistics pattern. Oit ledger: Low-20 alarms, corrected
  Statistics pattern.

## Watch-list (passive, next few days)

| When | Expect |
|---|---|
| Tonight 00:00 UTC | Both digests carry `notable warn+ findings` section; oit's cert count jumps once as the 3 expired us-east-1 certs enter (then fingerprints hold) |
| Next cert re-alert window | The two eu-central-1 expired certs (`prana-dev.pvhcorp.com`, `vpc.dev.oit.eu.pvh.cloud`) come back as `info` superseded/unattached instead of critical -- IF a valid same-region successor exists; otherwise still critical (the DigiCert->AWS renewals were confirmed by live agent enumeration) |
| Sunday 00:00 UTC | First scheduled suppression review mail from both monitors |
| Next Statistics alarm state change | First `suppressed_finding` match for the corrected pattern (0 matches right after adding is EXPECTED -- suppression applies at emission time, existing fingerprints sit in their re-alert window) |

## How to query a monitor headlessly (used today, keep)

```bash
# tunnel (background):
aws ssm start-session --profile eu-shared-services-dev --region eu-central-1 \
  --target i-042d0fed0cb5d8702 --document-name AWS-StartPortForwardingSession \
  --parameters portNumber=8787,localPortNumber=8788
# one-shot script (re-create in scratchpad; registers as `simon` via
# ~/.pi-coms-corp-token-simon, reuses scripts/monitor/coms.ts MonitorComs):
#   bun ask-monitors.ts "<command>" monitor-eu-oit-dev [monitor-eu-shared-services-dev]
# commands: run-checks status digest review history suppressions suppress|unsuppress
```

## Verification commands

```bash
bun test                                          # 187 pass
bun build extensions/coms-net.ts --external '*' --outfile /dev/null
bun build scripts/coms-net-monitor.ts --external '*' --outfile /dev/null
# per host via SSM:
cat /home/piagent/pi-coms/.bundle-version         # 0122280 (or later)
systemctl is-active pi-agent pi-monitor herdr     # active x3
# monitor registration log line now ends: "... daily @daily; review @weekly; reporting to ops"
```

## Risks / gotchas hit today

| Risk | Note |
|---|---|
| AWS creds expire mid-rollout | Profiles `eu-shared-services-dev` / `eu-oit-dev` are pasted temp STS creds; Claude cannot refresh them. Probe `sts get-caller-identity` before a publish; memory `aws-creds-pasted-sts` |
| Digest length vs inbox preview | Notables digest ~1.3 KB fits the new 2000-char preview; a very noisy day can still cut the tail -- the `…` marker + `msg_id` re-read rule covers it |
| Suppression added, 0 matches shown | Expected (emission-time matching + fingerprint re-alert windows); do not "fix" it |
| Bare-name ledger patterns | The review catches them now (0 matches forever); pattern must be a LIKE over `alarm:<name>:%`-shaped keys |
| zsh in Bash tool | No word-splitting in `for P in "a b c"` loops; use explicit per-host commands or `until` loops |

## Out of scope (deliberately not done)

- Deleting the expired unattached ACM certs (account-owner action).
- Scanning all AWS regions for certs (region list env is the extension point).
- Auto-unsuppressing stale ledger entries (operator decision stays manual).

## Memory references

`aws-creds-pasted-sts` (new today), `corp-pilot-live`, `artifact-no-ticket-refs`
(style rules for the deployment artifact), `guides-stow-symlink`.
