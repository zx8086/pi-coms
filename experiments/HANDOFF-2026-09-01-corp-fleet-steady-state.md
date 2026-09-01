# HANDOFF 2026-09-01 -- corp fleet steady state: pipeline healthy, owner findings pending

- Date: 2026-09-01 (morning)
- Tickets this session, all Done: SIO-1584 (verified), SIO-1585, SIO-1586,
  SIO-1587, SIO-1588, SIO-1589, SIO-1590
  -- https://linear.app/siobytes/issue/SIO-1590 is the most recent
- Repo state: `main` @ `cd8b9da`. No uncommitted work except the untracked
  `guides/` directory that predates these sessions.
- Prior handover (full 2026-08-31 history, superseded by this one for
  pickup): `experiments/HANDOFF-2026-08-31-corp-fleet.md`
- Deployment reference (live artifact, keep updating THIS url):
  https://claude.ai/code/artifact/29d0a2ec-2d43-43b4-91e5-b3f507c34fe0

## TL;DR

Done: the corp monitor pipeline is healthy end to end for the first time --
diagnosis works (agents see the response schema, budgets scale with batch
size), the logs check runs (log-content IAM granted) with relevance controls
(no WARN, caps, UUID-proof dedup, /aws/events/ excluded, 90 d journal
retention), INSUFFICIENT_DATA is info, digests go durably to the `ops` peer,
and the poc estate's terraform is destroyed. What's next: hand four
account-side findings to their owners, restart the operator tunnel/session,
and settle O4/O8/R1/R3. Gotcha that shaped the night: things the model
"cannot see" (schema in message details) and things the monitor did to
itself (its own CloudTrail echo) looked identical to real failures until
read from the journals.

## Current deployed state (verified this morning)

| Thing | Value |
|---|---|
| Repo | `main` @ `cd8b9da`; fleet bundle `5f5d7b2` on both agent hosts (PRs #40/#41 were docs-only, not bundled) |
| Hub | `i-042d0fed0cb5d8702`, `http://10.34.89.51:8787` (IP pinned), systemd unit `coms-hub`, account 352896877281 |
| Shared agent host | `i-0c3605a259454e861` (profile `eu-shared-services-dev`, eu-central-1) runs `eu-shared-services-dev` + `monitor-eu-shared-services-dev` |
| OIT agent host | `i-02918165c40f57815` (profile `eu-oit-dev`, eu-central-1) runs `eu-oit-dev` + `monitor-eu-oit-dev` |
| Model | Bedrock `eu.anthropic.claude-sonnet-5` under `assumed-role/DevOpsAgentReadOnly` (profile `devops-readonly` on hosts) |
| Digests/reports | `PI_MONITOR_REPORT_TO=ops` (bootstrap writes it to `~/.coms-env`); durable in the hub mailbox |
| Inbox read | tunnel `aws ssm start-session --profile eu-shared-services-dev --region eu-central-1 --target i-042d0fed0cb5d8702 --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["8787"],"localPortNumber":["8787"]}'` then `GET http://127.0.0.1:8787/v1/mailbox?name=ops` with the bearer from `~/.pi-coms-corp-token-simon` (never print it) |
| Terraform | both corp roots converge to No changes at `main`; poc root destroyed AND deleted from the repo (SIO-1586) |
| Fleet deploy | `./deploy/publish-fleet.sh pi-coms-dist-352896877281 eu-shared-services-dev`, then SSM `bash /var/lib/cloud/instance/user-data.txt` per host; agents need the pkill restart ONLY when `extensions/` changed |

## What shipped this session (all merged, deployed, live-verified)

| PR | What |
|---|---|
| #30 | SIO-1586: poc terraform root destroyed (12 resources, account 356994971776) and removed from the repo; docs template repointed to `accounts/eu-oit-dev`. VPS pieces deliberately left as-is (parked plan in the ticket) |
| #32 | SIO-1585: bootstrap polls `sts get-caller-identity` before the first credentialed call (cold-boot IMDS gap) |
| #34 | SIO-1587: digests/reports to `ops` (bootstrap layer -- terraform/userdata would replace instances) |
| #36 | SIO-1588: `response_schema` now rides in the inbound turn CONTENT (was `details`, invisible to the model; both agents guessed the same wrong shape); investigate budget scales base 5 min + 60 s/finding, cap 30 min (`investigateBudgetMs`) |
| #37 | SIO-1589: `LogContentReads` in `pi-coms-dev-extensions` (FilterLogEvents/GetLogEvents/StartQuery/GetQueryResults, applied+verified both accounts) plus logs-check relevance: WARN dropped, DescribeLogGroups paginated past the 50-group cutoff (cap 200), 3 sigs/group + 10 findings/cycle caps with info overflow, journal pruned to 90 d daily |
| #39 | SIO-1590: UUIDs normalize to `<uuid>` in `logSignature` (4-char UUID segments were defeating dedup -- one old-code cycle emitted a 129-signature overflow of the monitor's own CloudTrail echo); `/aws/events/` excluded by default; INSUFFICIENT_DATA warn -> info |

Live proofs on record: 03:36Z shared cycle produced 7 capped log findings
WITH parsed diagnoses (SIO-1588/1589); 05:00Z first new-code cycle ran
findings 0 (SIO-1590 F1); 06:30Z INSUFFICIENT_DATA arrived as info,
uninvestigated (SIO-1590 F2). Diagnoses now cite prior dedup keys, so the
journal's prior-incident context demonstrably reaches the agents.

## Next steps

1. Hand the account-side findings to their owners (none passed along yet):
   - oit: `stock-service` held at desiredCount 0 by the nightly cost
     schedule while `localcore-service`'s nightlySyncVariantStock job needs
     it (HTTP 503s) -- real cross-service scheduling conflict.
   - oit: recurring `order-service` ImagesClientV2 HTTP 404s from the
     Images API for specific style codes (missing image mappings; diagnosed
     with request ids in the mailbox reports).
   - shared: custom `statistics-exception` metric spikes in daily bursts
     (410 events 08-31, 320 on 09-01) with long silences -- likely a daily
     job throwing repeatedly.
   - both: `*-Utilization-Low-20` alarms with 60 s single-datapoint
     evaluation flap through task-recycle windows -- alarm tuning, theirs.
2. Operator decision: do `*-Low-*` ALARM transitions deserve critical in
   monitor reports, or is that left to per-account alarm tuning? (Today
   every ALARM maps to critical in `checks/alarms.ts`.)
3. Operator laptop: restart the SSM tunnel (hub `i-042d0fed0cb5d8702`, port
   8787) and the coms session (loads the AGENTS.md parity rule).
4. Open items on the deployment reference page: O4 security sign-off, O8
   VPN CIDR, R1 org Bedrock policy for agentic workloads, R3 plain HTTP on
   the private wire (internal ALB + private CA only if policy demands).
5. Passive check tonight: the midnight scale-to-zero should produce
   info-only INSUFFICIENT_DATA reports with zero investigations; tomorrow's
   digest should show check errors near 0.

## Gotchas (carried forward + new this session)

- Fleet deploy order: publish bundle -> SSM re-run `user-data.txt` per
  host. That restarts pi-monitor but leaves a live registered Pi agent
  alone; when `extensions/` changed, follow with
  `pkill -TERM -u piagent -f cli.js`, wait for exit, `systemctl restart
  pi-agent` (it re-registers within seconds; verify via the start script's
  "agent registered" output).
- SSM quoting: write a script locally, base64 it,
  `echo <b64> | base64 -d > /tmp/x.sh && bash /tmp/x.sh`. `aws ssm wait
  command-executed` gives up after ~100 s -- poll status in a loop for
  long host-side commands. Foreground `sleep` is blocked locally; host-side
  waits inside SSM commands are fine.
- Terraform corp roots: `lifecycle ignore_changes [ami]` + `user_data_replace_on_change = true`
  -- ANY userdata-affecting change REPLACES instances. Always read the
  "forces replacement" lines. Per-host config that must not churn instances
  goes in the bootstrap (see SIO-1587).
- AWS SSO tokens expire (~midnight bit this session): re-auth with
  `! aws sso login --profile eu-shared-services-dev` in-session.
- Quiet monitor cycles log NOTHING to journalctl; the sqlite journal
  (`~/.pi/monitor/state.db`, table `journal`) is the ground truth. Query it
  host-side with bun:sqlite as piagent.
- The monitor observing an account CHANGES the account: its API calls land
  in CloudTrail/EventBridge log groups. Anything scanning those groups sees
  the monitor itself; `/aws/events/` is excluded by default now, but the
  pattern generalizes.
- `GET /v1/agents` hides explicit peers (monitors); check
  `journalctl -u coms-hub` on the hub host for their register lines.
- VPS (server.siobytes.cloud): pi-coms pieces still installed but
  DEPRECATED, do not deploy; `/srv` is the infra-runbooks git repo -- never
  run git under `/srv/pi-coms`.

## Verification commands

```bash
# corp roots converge (run in each of deploy/accounts/eu-*-dev)
terraform plan -detailed-exitcode -input=false   # expect: No changes, EXIT=0
# tests
bun test                                          # expect: 93 pass, 0 fail
# host state (via SSM base64 pattern, per host):
cat /home/piagent/pi-coms/.bundle-version         # expect: 5f5d7b2 (or later)
systemctl is-active pi-agent pi-monitor herdr     # expect: active x3
```

## Memory references

`corp-pilot-live` (updated with this session's full arc), `poc-account-facts`
(DECOMMISSIONED banner), `vps-hub-deploy-layout` (DEPRECATED banner),
`corp-dev-held-branch`, `theme-preference`.
