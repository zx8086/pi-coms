// scripts/monitor/checks/logs.ts
import { DescribeLogGroupsCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import * as crypto from "node:crypto";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

const FILTER_PATTERN = "?ERROR ?WARN ?Exception";
const MAX_GROUPS = 50;

// Stable signature for grouping: recurring errors differ only in ids,
// timestamps, and counters.
export function logSignature(message: string): string {
	const normalized = message
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
		.replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
		.replace(/\d+/g, "<n>")
		.slice(0, 120);
	return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export async function checkLogs(
	client: AwsClient,
	state: MonitorState,
	opts: { now?: number; reAlertMs?: number; lookbackMs?: number } = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const reAlertMs = opts.reAlertMs ?? 86_400_000;
	const lookbackMs = opts.lookbackMs ?? 900_000;
	const findings: Finding[] = [];

	const groupsResp = await client.send(new DescribeLogGroupsCommand({ limit: MAX_GROUPS }));
	const groups: string[] = (groupsResp.logGroups ?? [])
		.map((g: any) => g.logGroupName)
		.filter(Boolean);

	for (const group of groups) {
		const wmKey = `logs:${group}`;
		const since = state.getWatermark(wmKey) ?? now - lookbackMs;
		const resp = await client.send(
			new FilterLogEventsCommand({
				logGroupName: group,
				startTime: since,
				endTime: now,
				filterPattern: FILTER_PATTERN,
			}),
		);
		const events: { timestamp: number; message: string }[] = resp.events ?? [];
		if (events.length === 0) continue;

		let maxTs = since;
		const bySig = new Map<string, { count: number; sample: string; lastTs: number }>();
		for (const e of events) {
			if (e.timestamp > maxTs) maxTs = e.timestamp;
			const sig = logSignature(e.message ?? "");
			const cur = bySig.get(sig) ?? {
				count: 0,
				sample: (e.message ?? "").slice(0, 300),
				lastTs: e.timestamp,
			};
			cur.count++;
			cur.lastTs = Math.max(cur.lastTs, e.timestamp);
			bySig.set(sig, cur);
		}
		state.setWatermark(wmKey, maxTs + 1);

		for (const [sig, agg] of bySig) {
			const key = `logs:${group}:${sig}`;
			if (!state.shouldAlert(key, reAlertMs)) continue;
			state.markAlerted(key, "logs");
			findings.push({
				family: "logs",
				severity: "warn",
				resource: group,
				summary: `${agg.count} error-pattern event(s) in ${group}`,
				dedup_key: key,
				evidence: { count: agg.count, sample: agg.sample, signature: sig },
				at: new Date(now).toISOString(),
			});
		}
	}
	return findings;
}
