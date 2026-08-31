# HANDOFF 2026-08-31 -- corp fleet: day-2 hardening, instructions, IAM

- Date: 2026-08-31 (evening)
- Tickets: SIO-1578, SIO-1579, SIO-1580, SIO-1581, SIO-1582 (all Done),
  SIO-1583 (In Progress, work complete, awaiting operator approval to mark Done)
  -- https://linear.app/siobytes/issue/SIO-1583
- Repo state: `main` @ `a2c9b56` (PR #26 merged). No uncommitted work except
  this file and the untracked `guides/` directory that predates the session.
  Late-evening addendum below covers up to `86bd352` (PR #30).
- Deployment reference (live artifact, keep updating THIS url, do not create a
  new one): https://claude.ai/code/artifact/29d0a2ec-2d43-43b4-91e5-b3f507c34fe0
  Local working copy: the session scratchpad file `pi-coms-feasibility.html`
  (re-read the artifact URL from a fresh session before editing).

## TL;DR

The corp dev fleet (hub + agent in eu-shared-services-dev 352896877281, agent
in eu-oit-dev 120999474587) is fully deployed, hardened after its first live
day, and verified end to end. What's done: OOM sizing fix, target_died
fast-fail, quiet mailbox, lenient JSON investigation replies, spoke/operator
instruction files, IAM scheduling reads + secret Deny boundary, hub IP pinned
and AMI drift frozen. What's next: operator confirms SIO-1583 Done, re-test
the shutdown question with the new permissions, and work the four remaining
open items (security sign-off, VPN CIDR, digest owner, poc/VPS refresh).
Gotcha that shaped the evening: a routine terraform apply rebuilt all three
instances via the latest-AMI data source; now impossible without -replace.

## Current deployed state (verified tonight)

| Thing | Value |
|---|---|
| Hub | `i-042d0fed0cb5d8702`, `http://10.34.89.51:8787` (IP PINNED via module `private_ip`), systemd unit `coms-hub`, directory auth at SSM `/pi-coms/auth`, root token `/pi-coms-hub/auth-token` |
| Shared agent host | `i-0c3605a259454e861` (t4g.small + 2 GB swap), runs `eu-shared-services-dev` + `monitor-eu-shared-services-dev` |
| OIT agent host | `i-02918165c40f57815`, runs `eu-oit-dev` + `monitor-eu-oit-dev` |
| Workload identity | `assumed-role/DevOpsAgentReadOnly`, ExternalId `devops-agent-dev-access`, profile `devops-readonly` on hosts |
| Fleet bundle | `s3://pi-coms-dist-352896877281/fleet/` @ `53267aa`; publish with `./deploy/publish-fleet.sh pi-coms-dist-352896877281 eu-shared-services-dev` |
| Operator principal | `simon` (names simon, ops, laptop), token file `~/.pi-coms-corp-token-simon` |
| SSH/observation | `herdr --remote pi-eu-shared-services-dev` / `pi-eu-oit-dev` (aliases in `~/.ssh/config`, SSM ProxyCommand, user piagent, key installed). Run OUTSIDE a local herdr session |
| Terraform | state local in `deploy/accounts/<account>/`; tfvars gitignored and secret; both roots converge to No changes at `a2c9b56` |

All three instances were REPLACED tonight (AMI drift, see gotchas): old ids
(`i-09ee98f5b8eed1d44`, `i-09bba2ee6a7c16265`, `i-0202477634d64e3bc`) appear
in older notes and are dead. Hub mailbox history and monitor state databases
were lost with them; monitors re-fingerprint, so early cycles may re-alert.

## What shipped today (all merged to main, all deployed)

| PR | What |
|---|---|
| #18 | 2 GB swap in bootstrap; corp agent hosts t4g.small (after an OOM kill mid-investigation, dmesg 14:45Z) |
| #19 | SIO-1578: hub fails delivered-but-unreplied messages with `target_died` when the target unregisters; awaits resolve immediately |
| #20 | SIO-1579: mailbox-class prompts carry `mailbox: true` and never trigger recipient turns; read on demand via `coms_net_inbox` |
| #21 | SIO-1580: `extractJsonPayload` (extensions/jsonPayload.ts) accepts fenced/prose JSON in schema replies -- fixed EVERY corp investigation failing as "response not valid JSON" (Sonnet 5 fences JSON); investigate() failures named in reports. Verified at the 16:15Z cycle |
| #22 | SIO-1581: `deploy/AGENTS-spoke.md` copied by bootstrap to the clone as `AGENTS.override.md` (spoke operating instructions; before this, spokes loaded the developer CLAUDE.md) |
| #23, #24 | SIO-1582: root `AGENTS.md` = operator console instructions; local toolbelt only on explicit request; per-account attribution rules |
| #25 | SIO-1583: inline `pi-coms-dev-extensions` gains scheduler/alarm-history/scheduled-action/rds-tag/ListRuleNamesByTarget/maintenance-window/compute-optimizer reads + explicit Deny on GetSecretValue, kms:Decrypt, SSM parameter values, lambda:GetFunction, data-plane gets. Both accounts verified byte-identical (parity by construction). Operator AGENTS.md parity rule added |
| #26 | Hub `private_ip` pinned (10.34.89.51); `lifecycle ignore_changes [ami]` on hub + agent instances |

Pi context-file precedence (load-order fact everything relies on):
`AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md`, per directory, from cwd.

IAM verification already performed (do not redo): both accounts' role documents
byte-identical; from the shared host under `devops-readonly`:
`scheduler list-schedules` -> 2 schedules, `application-autoscaling
describe-scheduled-actions --service-namespace ecs` -> 50 actions,
`describe-alarm-history` works, `get-secret-value` -> AccessDeniedException.

## Next steps

1. DONE 2026-08-31 evening -- operator marked SIO-1583 Done (20:46Z).
2. DONE 2026-08-31 evening -- re-test with new permissions passed. Both agents
   answered the shutdown question from configuration: ECS scale-to-zero via
   Application Auto Scaling scheduled actions (shared: 64 actions, down 17:00
   up 08:00 MON-FRI Europe/Amsterdam, off all weekend; oit: 46 actions, down
   00:00 up 07:30 daily) plus an EventBridge Scheduler pair invoking
   `lambda-shutdown-rds` per account (shared 18:00/07:00 MON-FRI; oit
   00:00/07:00 daily). Grounded negatives across the board (no ASGs, no
   maintenance windows, no Instance Scheduler), scope disclosed (shared
   checked eu-central-1 only; oit swept all 17 regions).
   Findings for the ACCOUNT OWNERS surfaced by the run: both accounts have
   `kong-konnect-proxy-service` with ScheduledScalingSuspended=true; shared
   has two kong services whose scale-UP actions set 0/0 (never come back) and
   four services never zeroed; both accounts carry enabled EventBridge rules
   with zero targets.
   New permission facts from the run:
   - `ssm:ListDocuments` / `ssm:ListAssociations` denied in both -- real gap;
     SSM Automation-document schedulers are unchecked. Candidate addition to
     `pi-coms-dev-extensions`.
   - The `kms:Decrypt` Deny blocks `lambda:GetFunctionConfiguration` wherever
     Lambda env vars are CMK-encrypted (observed in oit). Working as intended
     for secret hygiene, but it means the shutdown Lambda's targeting logic is
     unreadable in such accounts -- accepted trade-off, revisit only if the
     operator wants a scoped exception.
3. Operator laptop: restart the SSM tunnel against hub id
   `i-042d0fed0cb5d8702` (port 8787; URL unchanged thanks to the pinned IP);
   restart the coms session to load the AGENTS.md parity rule.
4. Open items on the deployment reference page: O4 security sign-off (page is
   the review package), O8 VPN CIDR for direct access, R1 confirm org Bedrock
   policy covers agentic workloads, R3 plain HTTP on the private wire (add
   internal ALB + private CA only if policy demands). O10 CLOSED 2026-08-31
   late evening -- digest owner is the `ops` peer (see addendum, SIO-1587).
5. CANCELLED, then DECOMMISSIONED 2026-08-31 late evening -- the operator
   retired the poc estate instead of refreshing it (SIO-1586, Done): the poc
   terraform root was destroyed (12 resources; `i-0bd23dad64ee9112b`
   terminated, both SSM params gone, state empty) and removed from the repo
   with docs repointed to `accounts/eu-oit-dev` as the copy-me template
   (PR #30, `86bd352`). The hand-installed VPS pieces (coms-hub container,
   traefik router for coms.siobytes.cloud, pi-agent/herdr units, /srv/pi-coms,
   DNS record) were deliberately left as-is; the parked teardown plan lives in
   SIO-1586's description if anyone ever wants it. NEVER git in /srv.
6. DONE 2026-08-31 late evening -- filed as SIO-1585, then implemented and
   deployed the same night (see addendum).

## Addendum -- late evening 2026-08-31 (fresh session, `86bd352`)

- SIO-1584 (ssm:ListDocuments/ListAssociations for schedule audits) merged as
  PR #29 and VERIFIED applied: both corp terraform roots converge to No
  changes, and both list calls succeed under `devops-readonly` on both agent
  hosts (checked via SSM, base64-script pattern). The last unchecked place a
  shutdown could hide (SSM Automation-document schedulers) is now readable.
- SIO-1585 filed, implemented, and DEPLOYED (Done): the bootstrap now polls
  `aws sts get-caller-identity` (10 x 3 s, gated to the aws paths) before its
  first credentialed call, closing the cold-boot IMDS gap that aborted an OIT
  boot. PR #32, `12cc882`; fleet bundle published at `12cc882`; bootstrap
  re-run on the shared host via SSM verified the warm path (bundle updated,
  sts wait present in the deployed script, all three units active, live agent
  left alone). OIT converges via pi-coms-update within 30 min. The cold-boot
  path gets its real proof on the next instance replacement.
- SIO-1586 executed and Done: poc estate decommissioned at terraform scope
  (see next-steps item 5 for detail). Scope was narrowed by the operator to
  what this repo's terraform built; VPS pieces and DNS stay as-is.
- Memory files updated: `poc-account-facts` and `vps-hub-deploy-layout` now
  open with DECOMMISSIONED/DEPRECATED banners so no future session redeploys
  the poc estate.
- SIO-1587 implemented and DEPLOYED (Done), closing O10: the bootstrap now
  writes `PI_MONITOR_REPORT_TO='ops'` into `.coms-env` (optional
  `MONITOR_REPORT_TO` env-contract override; bootstrap layer on purpose --
  a userdata/terraform change would replace the instances). PR #34,
  `efdf522`; bundle published; bootstrap re-run on BOTH corp hosts, verified:
  bundle at `efdf522`, the export present, pi-monitor active and restarted
  21:50Z. Digests now wait durably in the hub mailbox for an `ops` session
  instead of depending on the laptop peer.
- Still open after tonight: next-steps items 3 (operator tunnel + session
  restart) and 4 (O4 security sign-off, O8 VPN CIDR, R1 Bedrock policy,
  R3 plain HTTP).

## Gotchas (hard-won tonight, will bite again)

- Latest-AMI data source is ForceNew: fixed by ignore_changes[ami], so AMI
  updates now require `terraform apply -replace=<instance>`. Both modules also
  set `user_data_replace_on_change = true` -- ANY userdata-affecting change
  (e.g. hub_url) REPLACES the instance. Always `terraform plan` and read the
  "forces replacement" lines before applying to these roots.
- SSM send-command quoting: inline quoting fails in this shell repeatedly.
  Reliable pattern: write a script locally, base64 it,
  `echo <b64> | base64 -d > /tmp/x.sh && bash /tmp/x.sh`.
- Foreground `sleep` is blocked; host-side waits inside SSM commands or
  `run_in_background` locally.
- `systemctl restart pi-agent` does not replace a live registered Pi ("already
  registered; leaving it alone"): `pkill -TERM -u piagent -f cli.js`, wait for
  exit, then restart the unit.
- The hub also feeds from the S3 bundle: hub deploy = publish bundle, then
  re-run `bash /var/lib/cloud/instance/user-data.txt` on the hub host via SSM.
- Explicit peers (monitors) are hidden from `GET /v1/agents` and the pool
  widget by design; check `journalctl -u coms-hub` for their register lines.
- herdr --remote: version mismatch triggers a remote update that bounces the
  agent (systemd recovers); nested attach refused from inside a local herdr.
- Secret hygiene: tokens live in tfvars (gitignored), SSM SecureStrings, and
  `~/.pi-coms-corp-token-simon`; never print them. The role now has an explicit
  Deny making secret reads structurally impossible for agents.

## Memory references

`corp-pilot-live` (ids, fixes, procedures -- updated tonight),
`corp-dev-held-branch`, `poc-account-facts`, `vps-hub-deploy-layout`,
`theme-preference`.
