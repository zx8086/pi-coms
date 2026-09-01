# HANDOFF 2026-09-01 (afternoon) -- Estate Watch shipped, fatigue fixed, review closed

- Date: 2026-09-01 (supersedes `experiments/HANDOFF-2026-09-01-corp-fleet-steady-state.md` for pickup)
- Tickets this session, both Done: SIO-1591 (Estate Watch adoptions),
  SIO-1592 (fatigue + diagnosability) -- https://linear.app/siobytes/issue/SIO-1592
- PRs merged: #43 (Estate Watch), #44 (docs corp-era refresh + estate-watch doc),
  #45 (fatigue fixes), #46 (wafv2:ListResourcesForWebACL), #47 (just hub-tunnel),
  #48 (tunnel docs back to explicit command)
- Repo state: `main` @ `e5229a7`. Untracked `guides/` predates these sessions.
- Fleet bundle on both hosts: `8da8814` (PRs #46-#48 touched only IAM/justfile/docs,
  nothing host-relevant; State Manager converges the version label harmlessly)
- Deployment reference (live artifact, keep updating THIS url):
  https://claude.ai/code/artifact/29d0a2ec-2d43-43b4-91e5-b3f507c34fe0

## TL;DR

Done: the Estate Watch tier ladder is live on both monitors (T0 identity gate,
hourly ingestion heartbeat, daily trail/cert/watchlist, suppression ledger,
DEGRADED digest with per-family error breakdown, bundle canary); the morning's
alert fatigue was root-caused and fixed (out-of-scope log groups were aborting
the whole logs check 26x/day per host; order-service option codes minted a
signature per SKU); the ledger is populated; the nuxeo WAF ingestion finding
was triaged to conclusion (real traffic lull, pipeline healthy); the security
review closed (O4 signed off, R1/R3 not issues -- only O8 VPN CIDR open); docs
and the artifact were brought fully current. What's next: passive verification
of tonight's digests, first exercised suppression on the next Low-alarm flap,
and the account-side findings still need owner handoff. Gotcha of the day: the
artifact has standing style rules now (no SIO-* ids, no storytelling).

## Current deployed state (verified this session)

| Thing | Value |
|---|---|
| Repo | `main` @ `e5229a7`; fleet bundle `8da8814` verified on both agent hosts, monitors re-registered 09:34Z |
| Hub | `i-042d0fed0cb5d8702`, `http://10.34.89.51:8787`, systemd `coms-hub`, account 352896877281. Tunnel: explicit `aws ssm start-session --target <id>` (documented) or `just hub-tunnel` (resolves by `tag:Name=pi-coms-hub-hub`) |
| Agent hosts | shared `i-0c3605a259454e861` (profile `eu-shared-services-dev`), oit `i-02918165c40f57815` (profile `eu-oit-dev`), eu-central-1 |
| Monitor schedule | `*/15` identity gate + alarms/logs/drift; `7 * * * *` ingestion heartbeat; `@daily` cost/trail/certs/watchlist + digest |
| Ledger | shared: `alarm:%-Utilization-Low-20:%`, `logs:/aws/msk/brokers:%`, 3 Confluent phone-home sig keys; oit: `alarm:%-Utilization-Low-20:%`. Commands: `suppressions`, `suppress <pattern> | <reason>`, `unsuppress <pattern>` |
| IAM (dev-extensions, applied both accounts, in place) | + `CertificateReads` (acm), + `WafAndDeliveryReads` (wafv2 Get/List incl. GetSampledRequests + ListResourcesForWebACL, firehose Describe/List) |
| Review state | O4 sign-off recorded; R1 (Bedrock policy) and R3 (plain HTTP private wire) closed as design-accepted facts; O8 (VPN CIDR) is the ONE open estate item; O9 principals as needed |
| Journal retention | 90 d confirmed correct by operator -- do not propose changing it |
| Tests | `bun test`: 134 pass |

## What shipped (all merged, deployed where host-relevant, live-verified)

1. SIO-1591 (PR #43, bundle `5f5d7b2`->`78fe62a`): identity gate skips a
   cycle's checks on STS mismatch/denial; suppression ledger; hourly
   Metrics-Insights ingestion heartbeat (same-hour 7d median, nightly
   scale-to-zero silent by construction); daily trail-status / cert-expiry /
   CloudTrail write-watchlist checks; DEGRADED digest header; `bundle:` line
   as deploy canary. Plan: `docs/superpowers/plans/2026-09-01-estate-watch-adoptions.md`;
   doctrine: `docs/architecture/estate-watch.md`.
2. Docs corp-era refresh (PR #44): deployment/networking/security/usage/
   overview/README rewritten for the corp fleet; VPS demoted to deprecation
   notes; estate-watch.md added; mailbox-retention description corrected
   (terminal mailbox rows ARE the durable inbox).
3. SIO-1592 (PR #45, bundle `8da8814`): a denied log group is now one info
   scoping finding and the scan continues (was: whole logs check aborted per
   cycle -- ALL 26 daily check errors on BOTH hosts); tokens of 8+ word chars
   with 2+ digits normalize to `<id>` in `logSignature` (option codes were one
   signature per SKU); digest shows `check errors: N (family=N)`; `status`
   carries 24 h finding/suppressed/check-error totals.
4. WAF triage concluded: `nuxeo-wafv2` protects only the `nuxeo-msk-dev` ALB,
   logs DIRECTLY to CloudWatch (no Firehose). All its traffic is blocked scan
   noise (AllowedRequests none, ALB RequestCount always 0 -- blocked requests
   never reach the ALB). The noise paused 07:56-08:56Z and resumed with the
   logs. Real traffic lull, heartbeat behaved correctly, no issue. PR #46
   added the `ListResourcesForWebACL` direction the agent lacked.
5. Artifact brought current across ~10 republishes and now carries standing
   style rules (memory `artifact-no-ticket-refs`): present-state only, no
   SIO-* ids, no storytelling, no closed risks; instruction-layering shown as
   two rows (spokes `AGENTS.override.md`, operators `AGENTS.md`).

## Next steps

1. Passive checks: tonight's digests should be non-DEGRADED with a per-family
   error line and `bundle: 8da8814`; the first Low-utilization alarm flap
   after 09:34Z should journal `suppressed_finding` rows instead of critical
   reports (pattern-matching against real keys already proven in-session).
2. Owner handoffs still pending (none passed along yet): oit stock-service /
   localcore nightly scheduling conflict; oit order-service ImagesClientV2
   404s (missing image mappings -- now ONE stable log signature); shared
   statistics-exception daily bursts; per-account alarm hysteresis tuning if
   teams ever want the Low-20 alarms back un-suppressed.
3. Operator decision available, not made: suppress the recurring kafka-ui
   JMX/RMI stale-broker-3 family in shared (three signatures seen 09:45Z);
   diagnosed benign but left active.
4. O8: get the VPN egress CIDR from the network team, allow-list it on the
   hub SG for direct access (method B).
5. Estate Watch deferred tiers stay deferred until the false-positive rate
   earns them: T2 top-N outliers, T4 deep audits, Config inventory deltas.

## Gotchas (new this session + still-true carryovers)

- The artifact style rules are operator-mandated: present state only, no
  ticket ids, no incident anecdotes ("agents need 2 GB", not the OOM story).
  Dates only as status/disposition records.
- The operator prefers the explicit `--target <hub-instance-id>` tunnel
  command in docs; `just hub-tunnel` exists but is deliberately not the
  documented path. Hub instance id is found via `tag:Name=pi-coms-hub-hub`.
- Ledger patterns are SQL LIKE on dedup_key. Alarm keys end `:STATE`, so use
  `alarm:%-Utilization-Low-20:%`; ingest keys end with a trailing colon
  (group names nest, colon is illegal in them).
- Suppression applies at finding-emission time: already-fingerprinted findings
  inside their re-alert window never reach the ledger, so `suppressed: 0`
  right after adding entries is expected, not a failure.
- MSK rebalance noise is one log signature PER CONSUMER GROUP -- exact-key
  suppression can never keep up there; the group-level pattern is deliberate.
- The monitor journal (`~/.pi/monitor/state.db`) is ground truth; read it
  host-side with a readonly bun:sqlite script via the SSM base64 pattern.
  Inbox messages are immutable and age out at 14 d; journal 90 d; long-term
  conclusions live in Linear.
- Fleet deploy order unchanged: publish bundle -> `pi-coms-update` via SSM per
  host; pkill agent-restart dance ONLY when `extensions/` changed (nothing
  this session needed it). IAM-only changes need terraform apply, no bundle.
- Terraform corp roots still REPLACE instances on any userdata-affecting
  change -- read the "forces replacement" lines; per-host config goes in the
  bootstrap.
- Linear auto-moves issues to Done when their PR merges (GitHub integration);
  don't fight it, append status instead.

## Verification commands

```bash
# corp roots converge (run in each of deploy/accounts/eu-*-dev)
terraform plan -detailed-exitcode -input=false   # expect: No changes, EXIT=0
bun test                                          # expect: 134 pass, 0 fail
# per host via SSM (base64 pattern for anything nontrivial):
cat /home/piagent/pi-coms/.bundle-version         # expect: 8da8814 (or later)
systemctl is-active pi-agent pi-monitor herdr     # expect: active x3
# ledger via any operator session:
#   ask monitor-eu-shared-services-dev for suppressions   (expect 5 entries)
#   ask monitor-eu-oit-dev for suppressions               (expect 1 entry)
```

## Memory references

`corp-pilot-live` (full arc incl. today), `artifact-no-ticket-refs` (artifact
style rules), `corp-dev-held-branch`, `theme-preference`; `poc-account-facts`
and `vps-hub-deploy-layout` remain decommission/deprecation banners.
