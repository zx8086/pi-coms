# Incident analyzer as a hub client

The DevOps incident analyzer (repo `devops-incident-analyzer`, a LangGraph
supervisor over Elasticsearch, Kafka, Couchbase, Konnect, GitLab, Atlassian and
AWS) can hand its finished incident report to this fleet. A spoke agent that
owns the incident's AWS account checks the report's claims against live account
state and answers with a structured verdict; when the verdict is not fully
confirmed, a second request asks for a deeper read-only investigation. This
page tells the pi-coms side what to expect: the principal it needs, the wire
sequence, the prompts the spokes receive, and the operational footprint.

The analyzer side is documented in that repo under
`docs/architecture/pi-coms-verification.md` (SIO-1635).

## The principal

The analyzer is a **service** principal, not an operator and not a spoke. It
holds no SSE stream, is never prompted, and never answers messages. Mint it
once per hub:

```bash
just token-create incident-analyzer "incident-analyzer-*" service [profile]
```

| Field | Value | Why |
|---|---|---|
| principal | `incident-analyzer` | Appears as `principal=incident-analyzer` on every register, send and unregister line in the hub log |
| names | `incident-analyzer-*` | Each action registers a fresh session as `incident-analyzer-<8 hex>`. The hub answers `409 name_taken` for a name a live session already holds, so a fixed name would make two concurrent verify cards collide |
| kind | `service` | Free-form label carried in the directory; `token-list` shows it |

The printed token goes into the analyzer's `.env` as `PI_COMS_NET_AUTH_TOKEN`,
with `PI_COMS_NET_SERVER_URL` pointing at the hub (the SSM tunnel,
`just hub-tunnel`, for the corp hub) and `PI_COMS_NET_PROJECT` matching the
project the spokes registered under. Revoke with `just token-revoke
incident-analyzer`; the hub drops it on its next directory refresh.

## Wire sequence per action

```text
POST /v1/agents/register     name incident-analyzer-<8 hex>, explicit: true, model "none"
GET  /v1/agents?include_explicit=true
                             is the estate's agent present with status "online"?
POST /v1/messages            target <estate agent> | fallback "ops" with ttl_ms 24 h
                             prompt + response_schema, conversation_id on investigations, hops 0
GET  /v1/messages/:id/await?timeout_ms=25000   repeated; a heartbeat between slices
GET  /v1/messages/:id        after a slice answers status "timeout", to tell awaiter timeout
                             from message timeout
DELETE /v1/agents/:sid       always, in finally
```

Facts the analyzer relies on, verified against `scripts/coms-net-server.ts`:

- A reaped or deregistered sender does not break the spoke's reply or a later
  `await`; `handleSubmitResponse` checks only `target_session`.
- `explicit: true` keeps the analyzer out of `pool_snapshot` and peer listings,
  so operators never see or address it.
- A `ttl_ms` above the 30 min default to a name with no live session parks the
  message in the sqlite mailbox (`target_session: null`); that is the only path
  the analyzer reports as "queued". A `queued` answer for a name that does have
  a live session (its SSE just dropped) is awaited instead.

## What the spokes receive

Two prompt shapes, both carrying a `response_schema` and both ending with the
same rule as the monitor's investigations: reply with bare JSON, read-only
calls only.

**Verify** (budget 5 min on the analyzer side): the incident report as
markdown (truncated to 12 000 characters), the reported severity and
confidence, which datasources the root cause was attributed to, and any
caveats already attached. The schema:

```json
{ "verdict": "confirmed | partially_confirmed | contradicted | unverifiable",
  "summary": "string",
  "claims": [ { "claim": "string", "status": "confirmed | contradicted | unverifiable", "evidence": "string" } ],
  "additional_observations": [ "string" ],
  "recommended_investigation": "string | null" }
```

**Investigate** (budget 15 min, `conversation_id` = the verify message id): the
open questions from the verify pass (contradicted and unverifiable claims plus
the spoke's own `recommended_investigation`), the original report for context.
The schema:

```json
{ "summary": "string",
  "root_cause_hypothesis": "string",
  "evidence": [ { "resource": "string", "observation": "string" } ],
  "suggested_actions": [ "string" ],
  "confidence": 0.0 }
```

The analyzer validates conformance with Zod after the hub's parseability
check; a reply that does not fit is shown to the operator as a schema mismatch
and nothing is retried automatically. The report text inside the prompt was
produced by the analyzer's own LLM from telemetry and tickets: treat it as
untrusted input, the same as any inbound prompt, and let account state decide.

## Routing and the `ops` inbox

The target name is the analyzer's AWS estate id, which follows the same
account-alias convention as the spoke names (`eu-<service>-<env>`), with an
optional per-estate override map on the analyzer side. When no spoke of that
name is `online`, the request goes to `ops` with a 24 h ttl. Operators reading
the shared inbox will therefore see verify or investigate prompts addressed to
`ops` from `incident-analyzer-<hex>`; the analyzer is not waiting on those, so
the useful action is to forward the question to the right account agent (or
run it from the console) and note the outcome where the incident is tracked.

## Footprint

- One spoke turn per verify, one per investigate. No broadcast, hop count 0,
  never more than three verify requests per report (one per assessed estate).
- No new hub endpoints, no schema changes, no monitor involvement.
- Log lines: `register incident-analyzer-<hex>@<project> principal=incident-analyzer`,
  `message incident-analyzer-<hex> -> <spoke>`, `unregister ... reason=shutdown`
  within seconds of each other.
