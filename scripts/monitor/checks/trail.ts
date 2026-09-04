// scripts/monitor/checks/trail.ts
import {
	DescribeTrailsCommand,
	type DescribeTrailsCommandOutput,
	GetTrailStatusCommand,
	type GetTrailStatusCommandOutput,
	type Trail,
} from "@aws-sdk/client-cloudtrail";
import { errorMessage } from "../errors.ts";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// An audit trail that silently stopped is critical even when nothing else is
// wrong: every other change detector downstream of it goes blind.
export async function checkTrail(client: AwsClient, state: MonitorState): Promise<Finding[]> {
	const findings: Finding[] = [];
	const at = new Date().toISOString();
	const resp = (await client.send(new DescribeTrailsCommand({}))) as DescribeTrailsCommandOutput;
	const trails: Trail[] = resp.trailList ?? [];

	if (trails.length === 0) {
		const key = "trail:none:";
		if (state.shouldAlert(key)) {
			state.markAlerted(key, "trail");
			findings.push({
				family: "trail",
				severity: "info",
				resource: "cloudtrail",
				summary: "No CloudTrail trails visible in this account",
				dedup_key: key,
				evidence: { trails: 0 },
				at,
			});
		}
		return findings;
	}
	state.clearAlerts("trail:none:");

	const errors: string[] = [];
	for (const t of trails) {
		const name: string = t.Name ?? t.TrailARN ?? "unknown";
		let status: GetTrailStatusCommandOutput;
		try {
			status = (await client.send(
				new GetTrailStatusCommand({ Name: t.TrailARN ?? name }),
			)) as GetTrailStatusCommandOutput;
		} catch (e) {
			// Shadow org trails from the management account can deny status reads
			// to a member account; only an all-trails failure is a check error.
			errors.push(`${name}: ${errorMessage(e)}`);
			continue;
		}
		const conditions: { key: string; severity: "critical" | "warn"; summary: string; evidence: unknown }[] = [];
		if (status.IsLogging === false) {
			conditions.push({
				key: `trail:${name}:logging`,
				severity: "critical",
				summary: `CloudTrail ${name} is NOT logging`,
				evidence: { isLogging: false, stopLoggingTime: status.StopLoggingTime ?? null },
			});
		}
		if (status.LatestDeliveryError) {
			conditions.push({
				key: `trail:${name}:delivery`,
				severity: "warn",
				summary: `CloudTrail ${name} delivery error: ${status.LatestDeliveryError}`,
				evidence: { error: status.LatestDeliveryError, attempted: status.LatestDeliveryAttemptTime ?? null },
			});
		}
		for (const c of conditions) {
			if (!state.shouldAlert(c.key, 86_400_000)) continue;
			state.markAlerted(c.key, "trail");
			findings.push({
				family: "trail",
				severity: c.severity,
				resource: name,
				summary: c.summary,
				dedup_key: c.key,
				evidence: c.evidence,
				at,
			});
		}
		// Recovery per condition that is no longer present.
		for (const [cond, present] of [
			["logging", status.IsLogging === false],
			["delivery", Boolean(status.LatestDeliveryError)],
		] as const) {
			const key = `trail:${name}:${cond}`;
			if (!present && !state.shouldAlert(key)) {
				state.clearAlerts(key);
				findings.push({
					family: "trail",
					severity: "info",
					resource: name,
					summary: `CloudTrail ${name} ${cond === "logging" ? "logging resumed" : "delivery recovered"}`,
					dedup_key: `${key}:recovered:${at}`,
					evidence: { condition: cond },
					at,
				});
			}
		}
	}
	if (errors.length === trails.length && trails.length > 0) {
		throw new Error(`all ${trails.length} trail status read(s) failed: ${errors.join("; ")}`);
	}
	return findings;
}
