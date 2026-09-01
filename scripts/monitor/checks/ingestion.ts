// scripts/monitor/checks/ingestion.ts
import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// The logs check finds errors that are present; this finds logging that
// stopped. A service that dies quietly produces zero findings there.
const EXCLUDE_PREFIXES = ["/aws/events/"];
const MIN_EVENTS = 10;
const BASELINE_DAYS = 7;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Metrics Insights grammar is unforgiving; keep the expression verbatim and
// substitute nothing.
const EXPRESSION =
	'SELECT SUM(IncomingLogEvents) FROM SCHEMA("AWS/Logs", LogGroupName) GROUP BY LogGroupName ORDER BY SUM() DESC LIMIT 500';

export type CheckIngestionOpts = {
	now?: number;
	minEvents?: number;
	excludePrefixes?: string[];
};

export async function checkIngestion(
	client: AwsClient,
	state: MonitorState,
	opts: CheckIngestionOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const minEvents = opts.minEvents ?? MIN_EVENTS;
	const excludePrefixes = opts.excludePrefixes ?? EXCLUDE_PREFIXES;
	// Whole-hour boundaries: the last complete hour is the observation, the
	// same hour on the prior 7 days is the baseline. Same-hour comparison makes
	// the nightly scale-to-zero silent by construction.
	const endMs = Math.floor(now / HOUR_MS) * HOUR_MS;
	const lastHourMs = endMs - HOUR_MS;
	const startMs = lastHourMs - BASELINE_DAYS * DAY_MS;

	const series = new Map<string, Map<number, number>>();
	let nextToken: string | undefined;
	do {
		const resp: any = await client.send(
			new GetMetricDataCommand({
				MetricDataQueries: [{ Id: "ingest", Expression: EXPRESSION, Period: 3600 }],
				StartTime: new Date(startMs),
				EndTime: new Date(endMs),
				NextToken: nextToken,
			}),
		);
		for (const r of resp.MetricDataResults ?? []) {
			const group: string = r.Label ?? "";
			if (!group || excludePrefixes.some((p) => group.startsWith(p))) continue;
			const points = series.get(group) ?? new Map<number, number>();
			const ts: Date[] = r.Timestamps ?? [];
			const vals: number[] = r.Values ?? [];
			for (let i = 0; i < ts.length; i++) points.set(new Date(ts[i]).getTime(), vals[i] ?? 0);
			series.set(group, points);
		}
		nextToken = resp.NextToken;
	} while (nextToken);

	const findings: Finding[] = [];
	for (const [group, points] of series) {
		const observed = points.get(lastHourMs) ?? 0;
		const history: number[] = [];
		for (let d = 1; d <= BASELINE_DAYS; d++) history.push(points.get(lastHourMs - d * DAY_MS) ?? 0);
		history.sort((a, b) => a - b);
		const baseline = history[Math.floor(history.length / 2)];
		// Trailing colon terminates the key: group names nest (/ecs/a prefixes
		// /ecs/a-b) but cannot contain ":", so prefix-based fingerprint clears
		// stay exact.
		const key = `ingest:${group}:`;
		const at = new Date(now).toISOString();

		if (observed === 0 && baseline >= minEvents) {
			if (!state.shouldAlert(key)) continue;
			state.markAlerted(key, "ingestion");
			findings.push({
				family: "ingestion",
				severity: "warn",
				resource: group,
				summary: `Log ingestion stopped in ${group}: 0 events last hour vs same-hour 7d median ${baseline}`,
				dedup_key: key,
				evidence: { observed, baselineMedian: baseline, hourUtc: new Date(lastHourMs).toISOString() },
				at,
			});
		} else if (observed > 0 && !state.shouldAlert(key)) {
			state.clearAlerts(key);
			findings.push({
				family: "ingestion",
				severity: "info",
				resource: group,
				summary: `Log ingestion resumed in ${group}: ${observed} event(s) last hour`,
				dedup_key: `${key}:recovered:${new Date(lastHourMs).toISOString()}`,
				evidence: { observed, hourUtc: new Date(lastHourMs).toISOString() },
				at,
			});
		}
	}
	return findings;
}
