# Security Model

What each component can do, what it cannot, and the controls at every boundary. The design goal: an agent that answers questions about a production AWS account must be safe to leave running unattended.

## Trust boundaries

```
+----------------+        bearer token         +----------------+
|  any client    | --------------------------> |      hub       |
|  (laptop pi)   |     TLS via Traefik         |  no AWS creds  |
+----------------+                             +-------+--------+
                                                       | SSE (outbound-opened)
                                                       v
                                               +----------------+
                                               |  AWS agent     |
                                               |  ViewOnlyAccess|
                                               +----------------+
```

1. **Client to hub**: one shared bearer token over TLS. Anyone with the token can join the pool, list peers, and send prompts.
2. **Hub to account**: none. The hub holds no cloud credentials; compromising it yields relay control, not account access.
3. **Agent to account**: an EC2 instance role. What an agent can reveal about its account is bounded by IAM, not by prompt discipline.

Every agent shares one token and one coms project; account isolation comes from names and IAM, not the namespace.

## Hub authentication

- Every `/v1/*` request requires `Authorization: Bearer <token>`; only `/health` is open. Comparison is length-guarded `crypto.timingSafeEqual` (`scripts/coms-net-server.ts:297-309`).
- There is no unauthenticated mode. If `PI_COMS_NET_AUTH_TOKEN` is unset and the bind is loopback, the hub generates a random 32-byte token; if the bind is non-loopback, it refuses to start (`scripts/coms-net-server.ts:1441-1454`).
- A generated token is written to `~/.pi/coms-net/projects/<project>/server.secret.json` with mode 0600. The client refuses to read that file unless its mode is exactly 0600 (`extensions/coms-net.ts:306-321`).
- No rate limiting exists beyond the per-target inbox cap (429) and the hop limit (409). The token is the perimeter.

## Network exposure

| Host | Inbound surface | Justification |
|------|----------------|---------------|
| Hub container | Loopback only (`127.0.0.1:8787`); public entry via Traefik TLS | Nothing reaches the hub except through the TLS proxy |
| AWS agent | None (security group has no ingress) | Prompts arrive over the SSE stream the agent opened outbound |
| VPS agent | Host's existing SSH only | Talks to the hub over loopback |

Shell access to AWS agents is SSM Session Manager -- no SSH keys, no open ports, IAM-audited. Optional `herdr --remote` requires an explicitly authorized public key and rides an SSM tunnel.

## IAM: the agent role

The role attached to each account's agent (`deploy/modules/agent/main.tf:83-127`):

| Policy | Scope |
|--------|-------|
| `ViewOnlyAccess` (managed) | Metadata-only reads. No `s3:GetObject`, no DynamoDB item reads, no secret values |
| `AmazonSSMManagedInstanceCore` (managed) | Session Manager |
| `read-agent-secrets` (inline) | `secretsmanager:GetSecretValue` on exactly its two boot secrets |
| `cloudwatch-logs-read` (inline) | `cloudwatch:DescribeAlarms`, `DescribeAlarmHistory`, `logs:FilterLogEvents`, `GetLogEvents`, `StartQuery`, `GetQueryResults` |
| `cost-explorer-read` (inline) | `ce:GetCostAndUsage`, for the monitor's daily cost check. Cost Explorer has no resource-level scoping |

`ViewOnlyAccess` was chosen over `ReadOnlyAccess` deliberately: the agent describes the environment; it does not read data. Widen deliberately, one named action at a time -- the CloudWatch inline policy is the model for how.

Note the boundary the CloudWatch widening crossed: `logs:GetLogEvents` is a data-plane read, so application log content is now visible to the agent and to anyone who can prompt it. Keep that in mind before granting further data reads.

The monitor process (`pi-monitor.service`) runs under the same instance role and the same constraint: it detects and reports, never remediates. The role stays read-only.

## Hub data at rest

The mailbox changed the hub's storage posture. Message rows -- **including prompt and response bodies** -- persist in `~/.pi/coms-net/projects/<project>/messages.db` (a Docker named volume on the VPS) from creation until delivery plus sweep. For default sends that window is minutes; for mailbox sends it is up to `PI_COMS_NET_MAX_TTL_MS` (default 7 days). Terminal rows are deleted by the sweep, not retained.

Consequences: compromising the hub host now yields recent and queued message content, not just live relay traffic. Treat the `coms-hub-mail` volume like the token file -- root-owned host storage on a box you already trust with TLS termination. Registry, streams, and awaiters remain memory-only.

## Secrets handling

| Secret | At rest | In transit | Notes |
|--------|---------|-----------|-------|
| Hub token | VPS: `/root/.secrets/.../coms-net-hub.env` (0600); AWS: per-account Secrets Manager copy | Fetched over SSH (`connect.sh`) or via instance role at boot | Never in git; tfvars and state are gitignored |
| Provider API keys | AWS: Secrets Manager, created empty by Terraform; VPS: `/root/.secrets` | Instance role fetch at bootstrap | Populated out of band so keys never land in Terraform state |
| Agent env | `~/.coms-env`, mode 0600, owned by `piagent` | -- | Written once at bootstrap |

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
3. The inbox cap (100) and message TTL bound queue-stuffing. Mailbox sends stretch the TTL to 7 days, and a send to an offline name is not counted by the inbox cap (the cap counts messages per live session, and there is none yet) -- for offline names the bound is the TTL sweep plus the single-token perimeter. Durability extends the window, not the audience: any token holder could already send at will.
4. The audit trail records who messaged whom, without retaining payloads that might themselves be sensitive.

There is no per-peer authorization: any token holder can prompt any agent. If peers ever need different privileges, that separation must come from separate hubs or projects with separate tokens.

## Operational rules

1. **Rotate the token by replacing it in the VPS env file, restarting the hub, and re-applying each account** (the module stores a per-account copy).
2. **Never widen `ViewOnlyAccess` wholesale.** Add named actions to an inline policy, as the CloudWatch policy does.
3. **Keep the hub at one replica.** Splitting the registry is an availability problem, not a security one, but a split registry makes name-based addressing unreliable, and names are the addressing scheme.
4. **Treat `terraform.tfstate` as secret material.** It contains the hub token.

## See Also

- [Networking](../architecture/networking.md) -- the listeners these boundaries protect
- [Communication](../architecture/communication.md) -- hop limits and audit logging in detail
- [Deployment](../deployment/deployment.md) -- where each secret is provisioned
