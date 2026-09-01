# Security Model

What each component can do, what it cannot, and the controls at every boundary. The design goal: an agent that answers questions about a production AWS account must be safe to leave running unattended.

## Trust boundaries

```
+----------------+     per-principal token     +----------------+
|  any client    | --------------------------> |      hub       |
|  (laptop pi)   |  SSM tunnel (TLS) or TGW    |  no AWS creds  |
+----------------+                             +-------+--------+
                                                       | SSE (outbound-opened)
                                                       v
                                               +----------------+
                                               |  AWS agent     |
                                               | DevOpsAgent-   |
                                               | ReadOnly       |
                                               +----------------+
```

1. **Client to hub**: a bearer token per principal (directory mode on the corp hub; a single shared token remains the default for local hubs). Operators reach the private hub through an SSM port-forward (TLS to the SSM service) or the corporate network; the hub is unreachable from the internet.
2. **Hub to account**: none. The hub holds no cloud credentials; compromising it yields relay control, not account access.
3. **Agent to account**: an assumed read-only role. What an agent can reveal about its account is bounded by IAM, not by prompt discipline.

All peers share one coms project; account isolation comes from names, name binding, and IAM, not the namespace.

## Hub authentication

- Every `/v1/*` request requires `Authorization: Bearer <token>`; only `/health` is open. Comparison is length-guarded `crypto.timingSafeEqual` (`scripts/coms-net-server.ts:297-309`).
- There is no unauthenticated mode. If `PI_COMS_NET_AUTH_TOKEN` is unset and the bind is loopback, the hub generates a random 32-byte token; if the bind is non-loopback, it refuses to start (`scripts/coms-net-server.ts:1441-1454`).
- A generated token is written to `~/.pi/coms-net/projects/<project>/server.secret.json` with mode 0600. The client refuses to read that file unless its mode is exactly 0600 (`extensions/coms-net.ts:306-321`).
- No rate limiting exists beyond the per-target inbox cap (429) and the hop limit (409). The token is the perimeter.

### Per-principal tokens (directory mode)

For multi-user deployments the single shared token can be replaced with one token per principal (each person, agent, and monitor). Directory mode activates when either source is set; unset, the hub behaves exactly as above.

| Variable | Source |
|----------|--------|
| `PI_COMS_NET_AUTH_SSM_PATH` | SSM Parameter Store path (e.g. `/pi-coms/auth`), one `SecureString` per principal, polled via the host's `aws` CLI |
| `PI_COMS_NET_AUTH_FILE` | A `tokens.json` file for non-AWS hubs: `{"principals": {"simon": {"token": "...", "kind": "operator", "names": ["simon", "ops"]}}}` |
| `PI_COMS_NET_AUTH_REFRESH_MS` | Directory refresh interval (default 60 s) |

Semantics:

1. The hub keeps only SHA-256 hashes of tokens in its long-lived map; each session records which principal registered it, and log lines carry `principal=`.
2. **Name binding**: a principal may only register names on its list (exact, `prefix-*`, or `*`); a name held by another principal's live session is `409 name_taken`, never auto-suffixed. This closes name-squatting: nobody can claim an agent's name during its restart window.
3. **Revocation**: deleting a principal's parameter (or file entry) takes effect on the next refresh -- further requests get 401 and live SSE sessions are closed with reason `revoked`. One person out; nobody else touched. A failed refresh keeps the previous directory, so a transient SSM error never locks the fleet out.
4. `PI_COMS_NET_AUTH_TOKEN`, if also set, acts as a root principal with unrestricted names (migration aid); in directory mode the hub can also run without it.

Administration is `just token-create <principal> [names] [kind] [profile]` / `token-revoke` / `token-list` (`deploy/token-admin.sh`), which are thin wrappers over `aws ssm` -- so who may create or revoke tokens is itself an IAM policy on the parameter path, and every action lands in CloudTrail. Tokens are printed once at creation and never stored outside Parameter Store.

## Network exposure

| Host | Inbound surface | Justification |
|------|----------------|---------------|
| Corp hub | TCP 8787 from allow-listed CIDRs only; no public IP, no internet path | Fleet VPCs reach it over the TGW; operators via SSM port-forward |
| AWS agent | None (security group has no ingress) | Prompts arrive over the SSE stream the agent opened outbound |
| Local dev hub | Loopback by default; non-loopback binds require an explicit token | Development only |

Shell access to AWS agents is SSM Session Manager -- no SSH keys, no open ports, IAM-audited. Optional `herdr --remote` requires an explicitly authorized public key and rides an SSM tunnel.

## IAM: the workload role (corp deployments)

With `readonly_role = true` (the corp default), the instance role holds only
host plumbing -- SSM core, its boot parameters, the distribution bucket, and
one `sts:AssumeRole` -- and every AWS read the workload performs runs as an
ExternalId-gated session of `DevOpsAgentReadOnly`, the production incident
analyzer's role recreated per account from the same two vendored policy
documents (`deploy/modules/agent/policies/`):

| Element | Content |
|---------|---------|
| `DevOpsAgentReadOnlyPermissions` | The prod base-read policy, verbatim: topology, compute, datastores, messaging, CloudWatch, name-scoped log content, Health/Config, CloudFormation, security/audit surfaces |
| `DevOpsAgentReadOnlyTroubleshooting` | The prod deep-dive policy, verbatim: network-path drill-down, Reachability, DNS, KMS metadata, `cloudtrail:LookupEvents`, quotas, flow-log content |
| `pi-coms-dev-extensions` (inline) | Named dev additions: `ce:GetCostAndUsage` (cost check), Bedrock invoke on Anthropic models, scheduling/history reads, `LogContentReads` (FilterLogEvents/GetLogEvents/StartQuery/GetQueryResults), `CertificateReads` (acm:List/DescribeCertificate for the cert-expiry check), and an explicit **Deny** on secret values, `kms:Decrypt`, SSM parameter values, `lambda:GetFunction`, and data-plane gets -- metadata-only made structural |

One reviewed permission set governs both this fleet and the incident
analyzer; every check, investigation read, and model call appears in
CloudTrail as a `DevOpsAgentReadOnly` session, cleanly separated from host
plumbing. Widen deliberately, one named action at a time, in the
dev-extensions policy.

Note the boundary the log widening crossed: `logs:GetLogEvents` is a
data-plane read, so application log content is visible to the agent and to
anyone who can prompt it. The explicit Deny keeps that the only data-plane
surface.

The monitor process (`pi-monitor.service`) runs under the same role and the
same constraint: it detects and reports, never remediates. The role stays
read-only. Doctrine: [Estate Watch](../architecture/estate-watch.md).

### Legacy instance-role mode

With `readonly_role = false` the module instead attaches everything directly
to the instance role: `ViewOnlyAccess` + `AmazonSSMManagedInstanceCore` +
inline `cloudwatch-logs-read`, `cost-explorer-read`, and boot-secret reads.
Same read-only constraint, no assumed-role separation.

## Hub data at rest

The mailbox changed the hub's storage posture. Message rows -- **including prompt and response bodies** -- persist in `~/.pi/coms-net/projects/<project>/messages.db` (a KMS-encrypted EBS volume on the corp hub) from creation until sweep. For default sends that window is minutes; mailbox-class messages are retained until their own TTL expires -- terminal rows included, because the retained rows ARE the durable inbox (`GET /v1/mailbox`), capped by `PI_COMS_NET_MAX_TTL_MS` (default 14 days).

Consequences: compromising the hub host yields up to 14 days of message content, not just live relay traffic. Registry, streams, and awaiters remain memory-only.

## Secrets handling

| Secret | At rest | In transit | Notes |
|--------|---------|-----------|-------|
| Hub/principal tokens | SSM `SecureString` parameters under `/pi-coms/auth/*` (and `/pi-coms-hub/auth-token` for the root token) | Instance role fetch at boot; operators self-fetch their own parameter | Printed once at creation; never in git, logs, or errors |
| Provider API keys | None in the corp deployment -- models run on Bedrock under the assumed role | -- | The keys parameter exists for non-Bedrock deployments, populated out of band |
| Agent env | `~/.coms-env`, mode 0600, owned by `piagent` | -- | Written by the bootstrap |

Client-side, `safeError()` string-replaces the live token with `<redacted>` in any user-visible error (`extensions/coms-net.ts:498-503`), and tokens are never written to audit entries. Terraform state contains the hub token (it is a variable), which is why state stays local and gitignored per account.

## What is logged, what is not

| Layer | Logged | Never logged |
|-------|--------|--------------|
| Extensions (`coms-log`, `coms-net-log`) | msg ids, peer names, hop counts, connection events, failures | Prompt text, response bodies, tokens |
| Hub stdout | Same, plus prompt previews truncated to 47 chars | Tokens, full session ids, response bodies |

The truncated prompt preview on the hub is the one place message content appears in any log. Set `PI_COMS_NET_LOG_QUIET=1` to suppress event lines entirely.

## Prompt-injection posture

Agents accept natural-language prompts from any peer holding the token, and inbound content is untrusted by definition. The controls are capability-based, not content-based:

1. The blast radius of a hostile prompt equals the agent's IAM role -- metadata reads plus the named CloudWatch actions.
2. The hop limit (5) stops a compromised or confused peer from fanning work across the fleet indefinitely.
3. The inbox cap (100) and message TTL bound queue-stuffing. Mailbox sends stretch the TTL to 14 days, and a send to an offline name is not counted by the inbox cap (the cap counts messages per live session, and there is none yet) -- for offline names the bound is the TTL sweep plus the single-token perimeter. Durability extends the window, not the audience: any token holder could already send at will.
4. The audit trail records who messaged whom, without retaining payloads that might themselves be sensitive.

In single-token mode there is no per-peer authorization: any token holder can prompt any agent. Directory mode (above) adds identity, name binding, and per-principal revocation; message-level authorization (who may prompt whom, who may read which inbox) remains open -- genuinely separate trust domains still belong on separate hubs.

## Operational rules

1. **Rotate tokens through the directory**: `just token-create` / `token-revoke` replace and evict per principal, live sessions included; the parameter path's IAM policy is the admin boundary and CloudTrail the audit.
2. **Never widen the read surface wholesale.** Add named actions to the dev-extensions inline policy; the explicit Deny stays.
3. **Keep the hub at one replica.** Splitting the registry is an availability problem, not a security one, but a split registry makes name-based addressing unreliable, and names are the addressing scheme.
4. **Treat `terraform.tfstate` as secret material.** It contains the hub token.

## See Also

- [Networking](../architecture/networking.md) -- the listeners these boundaries protect
- [Communication](../architecture/communication.md) -- hop limits and audit logging in detail
- [Deployment](../deployment/deployment.md) -- where each secret is provisioned
