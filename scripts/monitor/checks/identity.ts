// scripts/monitor/checks/identity.ts
import { GetCallerIdentityCommand, type GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import { errorMessage } from "../errors.ts";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

export type GateResult = { findings: Finding[]; healthy: boolean };

const FAIL_PREFIX = "identity:";
const REALERT_MS = 86_400_000;

// T0 gate: a monitor that silently loses access reports "all quiet" forever.
// Wrong-account detection exists because credential files and their comments
// have carried wrong account ids before; STS is the only trusted source.
// healthy is reported separately from findings: a still-broken identity stays
// unhealthy (so the cycle keeps skipping its checks) even while the finding
// itself is deduped.
export async function checkIdentity(
	client: AwsClient,
	state: MonitorState,
	opts: { expectedAccountId?: string } = {},
): Promise<GateResult> {
	const expected = opts.expectedAccountId;
	const at = new Date().toISOString();
	let account: string | null = null;
	let arn: string | null = null;
	let error: string | null = null;
	try {
		const resp = (await client.send(new GetCallerIdentityCommand({}))) as GetCallerIdentityCommandOutput;
		account = resp.Account ?? null;
		arn = resp.Arn ?? null;
	} catch (e) {
		error = errorMessage(e);
	}

	const mismatch = error === null && expected && expected !== "unknown" && account !== expected;
	if (error !== null || mismatch) {
		const key = error !== null ? "identity:error" : `identity:mismatch:${account}`;
		if (!state.shouldAlert(key, REALERT_MS)) return { findings: [], healthy: false };
		state.markAlerted(key, "identity");
		return {
			healthy: false,
			findings: [
				{
					family: "identity",
					severity: "critical",
					resource: "sts:GetCallerIdentity",
					summary:
						error !== null
							? `Identity check failed: ${error}`
							: `Identity mismatch: STS says account ${account}, expected ${expected}`,
					dedup_key: key,
					evidence: { account, arn, expected: expected ?? null, error },
					at,
				},
			],
		};
	}

	// Recovery: only a finding when a failure was alerted before.
	const prior = state.alertKeys(FAIL_PREFIX);
	if (prior.length > 0) {
		state.clearAlerts(FAIL_PREFIX);
		return {
			healthy: true,
			findings: [
				{
					family: "identity",
					severity: "info",
					resource: "sts:GetCallerIdentity",
					summary: `Identity check recovered: account ${account}`,
					dedup_key: `identity:recovered:${account}`,
					evidence: { account, arn },
					at,
				},
			],
		};
	}
	return { findings: [], healthy: true };
}
