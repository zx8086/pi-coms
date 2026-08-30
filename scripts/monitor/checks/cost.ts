// scripts/monitor/checks/cost.ts
import { GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

export async function checkCost(
	client: AwsClient,
	state: MonitorState,
	opts: { now?: Date; pct?: number; abs?: number } = {},
): Promise<Finding[]> {
	const now = opts.now ?? new Date();
	const pct = opts.pct ?? 20;
	const abs = opts.abs ?? 1;

	const end = now.toISOString().slice(0, 10); // exclusive
	const start = new Date(now.getTime() - 15 * 86_400_000).toISOString().slice(0, 10);
	const resp = await client.send(
		new GetCostAndUsageCommand({
			TimePeriod: { Start: start, End: end },
			Granularity: "DAILY",
			Metrics: ["UnblendedCost"],
		}),
	);

	for (const r of resp.ResultsByTime ?? []) {
		const date = r.TimePeriod?.Start;
		const amount = Number(r.Total?.UnblendedCost?.Amount ?? "0");
		if (date) state.recordCost(date, amount);
	}

	const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
	const latest = state.latestCost();
	if (!latest || latest.date !== yesterday) return [];
	const baseline = state.costBaseline(yesterday, 14);
	if (baseline === null) return [];

	// Alert only when over by BOTH thresholds: pct filters noise on small
	// accounts, abs filters noise on near-zero baselines.
	const overPct = latest.usd > baseline * (1 + pct / 100);
	const overAbs = latest.usd > baseline + abs;
	if (!(overPct && overAbs)) return [];

	const key = `cost:${yesterday}`;
	if (!state.shouldAlert(key)) return [];
	state.markAlerted(key, "cost");
	return [{
		family: "cost",
		severity: "warn",
		resource: "account",
		summary: `Spend ${yesterday} was $${latest.usd.toFixed(2)} vs 14d baseline $${baseline.toFixed(2)} (+${((latest.usd / baseline - 1) * 100).toFixed(0)} pct)`,
		dedup_key: key,
		evidence: { date: yesterday, usd: latest.usd, baseline },
		at: now.toISOString(),
	}];
}
