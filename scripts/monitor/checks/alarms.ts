// scripts/monitor/checks/alarms.ts
import { DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";

export interface AwsClient {
	send(cmd: any): Promise<any>;
}

export async function checkAlarms(client: AwsClient, state: MonitorState): Promise<Finding[]> {
	const findings: Finding[] = [];
	const resp = await client.send(new DescribeAlarmsCommand({}));
	const alarms = [...(resp.MetricAlarms ?? []), ...(resp.CompositeAlarms ?? [])];
	for (const a of alarms) {
		const name: string = a.AlarmName ?? "unknown";
		const sv: string = a.StateValue ?? "OK";
		const key = `alarm:${name}:${sv}`;
		const prefix = `alarm:${name}:`;
		if (sv === "OK") {
			// Recovery is a finding only when a non-OK state was alerted before.
			const prior = state.alertKeys(prefix).filter((k) => k !== key);
			if (prior.length > 0) {
				state.clearAlerts(prefix);
				state.markAlerted(key, "alarm");
				findings.push({
					family: "alarm",
					severity: "info",
					resource: name,
					summary: `Alarm ${name} recovered to OK`,
					dedup_key: key,
					evidence: { state: sv, reason: a.StateReason ?? null },
					at: new Date().toISOString(),
				});
			}
			continue;
		}
		if (!state.shouldAlert(key)) continue;
		state.clearAlerts(prefix);
		state.markAlerted(key, "alarm");
		findings.push({
			family: "alarm",
			severity: sv === "ALARM" ? "critical" : "warn",
			resource: name,
			summary: `Alarm ${name} entered ${sv}`,
			dedup_key: key,
			evidence: { state: sv, reason: a.StateReason ?? null },
			at: new Date().toISOString(),
		});
	}
	return findings;
}
