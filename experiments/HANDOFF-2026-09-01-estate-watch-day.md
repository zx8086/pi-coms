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
| Repo | `main` @ `e5c621a` (SIO-1597 merged 2026-09-02); last host-verified fleet bundle `8da8814`, monitors re-registered 09:34Z on 2026-09-01; `84c542e`-era bundle converging via State Manager |
| Hub | `i-042d0fed0cb5d8702`, `http://10.34.89.51:8787`, systemd `coms-hub`, account 352896877281. Tunnel: explicit `aws ssm start-session --target <id>` (documented) or `just hub-tunnel` (resolves by `tag:Name=pi-coms-hub-hub`) |
| Agent hosts | shared `i-0c3605a259454e861` (profile `eu-shared-services-dev`), oit `i-02918165c40f57815` (profile `eu-oit-dev`), eu-central-1 |
| Monitor schedule | `*/15` identity gate + alarms/logs/drift; `7 * * * *` ingestion heartbeat; `@daily` cost/trail/certs/watchlist + digest |
| Ledger | shared: `alarm:%-Utilization-Low-20:%`, `logs:/aws/msk/brokers:%`, 3 Confluent phone-home sig keys; oit: `alarm:%-Utilization-Low-20:%`. Commands: `suppressions`, `suppress <pattern> | <reason>`, `unsuppress <pattern>` |
| IAM (dev-extensions, applied both accounts, in place) | + `CertificateReads` (acm), + `WafAndDeliveryReads` (wafv2 Get/List incl. GetSampledRequests + ListResourcesForWebACL, firehose Describe/List) |
| Review state | O4 sign-off recorded; R1 (Bedrock policy) and R3 (plain HTTP private wire) closed as design-accepted facts; O8 (VPN CIDR) is the ONE open estate item; O9 principals as needed |
| Journal retention | 90 d confirmed correct by operator -- do not propose changing it |
| Tests | `bun test`: 142 pass (2026-09-02, after SIO-1597) |

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
6. Artifact restructured (evening session, same url):
   - Content additions from today's merges: WAF/firehose reads in the
     dev-extensions IAM row, denied-log-group scoping + identifier-token
     normalization in the logs-check row, per-family check-error count in the
     digest description, `suppress <pattern> | <reason>` syntax in the Estate
     Watch row.
   - Verdict box merged into the header summary paragraph; the standalone
     callout is gone.
   - ALL aside/commentary paragraphs removed (token-spend consequence,
     access-method default, inbox semantics, IAM payoff, model default,
     one-flow/rollback, honest boundary, concurrency, sign-off). Facts not
     stated elsewhere moved into the adjacent tables: security sign-off as an
     open-items row, `AWS_PROFILE` operator access as a Bedrock row, Rollback
     and Outside-the-bundle as update-stage rows, single-instance hub into the
     mailbox note.
   - Full-page storytelling pass: rationale clauses, metaphors, temporal
     phrases (exactly as today / New / still / day one), emphasis words
     (critically, full stop), editorial asides all removed. Access-method
     badges now read "default" (A) and "pending O8" (B).
   - Layout: `p { max-width: 70ch }` removed so paragraphs span the same
     880px column as the tables.
7. Artifact readability pass (2026-09-02, same url, label
   `plain-summary-o8-only`):
   - Header summary rewritten in plain language: what the system is (private
     fleet of AI agents inside the company network), what the hub does
     (relays messages, queues reports until the operator connects), and the
     access facts in everyday terms (read-only role, Bedrock under the same
     role, no API keys, updates from a shared S3 bundle). Only remaining
     technical token is the hub address.
   - Open items table trimmed to O8 only. O9 (principals as-needed) and the
     security-review sign-off row removed -- the sign-off is no longer
     recorded on the page; this handover and Linear remain the record.
8. SIO-1597 (PR #51, merged 2026-09-02, main @ `e5c621a`): drift detection
   extended beyond EC2 and the CloudTrail watchlist widened.
   - New `scripts/monitor/checks/resource-drift.ts` on the 15-min cycle,
     snapshot-diffing security-group rules (change = warn), route-table
     routes (change = warn), RDS settings (public flip = critical, status =
     warn, class/version = info), Lambda config via one paginated
     ListFunctions (role = warn, rest info). First run baselines silently;
     a failing sub-scan is one fingerprinted info finding and the other
     scans continue.
   - `DEFAULT_WATCHLIST` + 9 events (SG egress/revocations, route
     create/replace/delete, DeleteRouteTable, DeleteBucketPolicy,
     PutPublicAccessBlock); ModifyDBInstance deliberately excluded
     (resource drift catches RDS within 15 min, watchlist is daily).
   - New deps `@aws-sdk/client-rds` + `@aws-sdk/client-lambda`. No IAM
     change (base policy already grants the describes). `bun test`: 142
     pass. `docs/architecture/monitoring.md` updated; artifact 15-min
     cadence, snapshots, and watchlist rows updated same day.
   - Post-deploy check: after both hosts converge on the `84c542e`-era
     bundle, the first cycle establishes SG/RTB/RDS/Lambda baselines
     silently -- expect no drift findings unless something actually changed.
9. Artifact readability sweep (2026-09-02, ~15 republishes, same url):
   em dashes removed page-wide with sentences restructured; monitor
   pipeline split into cadence + step tables with explanatory intros;
   multi-operator, token-admin, storage (memory vs disk, restart
   semantics), monitor-state, and herdr-remote sections expanded to
   explain rather than compress; instruction-files block moved to an
   appendix; Estate Watch tier ladder added as an appendix (replaces the
   repo-path reference); two factual fixes (reports are read on demand,
   not pushed to `laptop`; three EC2 instances, not two); method A/B
   snippets show the raw `pi -e extensions/coms-net.ts` command.

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
  Dates only as status/disposition records. Extended 2026-09-01 evening: no
  aside/commentary paragraphs at all -- facts live in the tables or section
  intros; no rationale clauses, metaphors, temporal phrases, or emphasis
  words; body text same width as tables. Extended 2026-09-02: header summary
  in plain language (technical identifiers stay in the section tables); open
  items lists only what actually needs action (currently O8).
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
