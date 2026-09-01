// scripts/monitor/checks/logs.ts
import { DescribeLogGroupsCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import * as crypto from "node:crypto";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// WARN is deliberately absent: in a dev account every warning line would
// become a warn finding, and warn findings trigger agent investigations.
const FILTER_PATTERN = "?ERROR ?Exception";
const MAX_GROUPS = 200;
// /aws/events/ groups hold EventBridge delivery echo (e.g. CloudTrail API
// records), not application logs; the monitor's own FilterLogEvents calls
// land there and match the pattern -- a self-referential false positive.
const EXCLUDE_PREFIXES = ["/aws/events/"];
const MAX_SIGS_PER_GROUP = 3;
const MAX_FINDINGS_PER_CYCLE = 10;

// Stable signature for grouping: recurring errors differ only in ids,
// timestamps, and counters.
export function logSignature(message: string): string {
	const normalized = message
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
		// UUIDs before the hex pass: their 4-char middle segments would
		// otherwise survive normalization and give every event a fresh
		// signature, defeating dedup.
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
		.replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
		// Mixed alphanumeric ids (option codes like UW0UW061470LZ, article
		// keys): a fresh signature per SKU defeats dedup exactly the way raw
		// UUIDs did. A token of 8+ word chars with 2+ digits is an id, not a
		// word; class names with a single version digit (ImagesClientV2) stay.
		.replace(/\b[A-Za-z0-9_]{8,}\b/g, (t) =>
			(t.match(/\d/g)?.length ?? 0) >= 2 ? "<id>" : t,
		)
		.replace(/\d+/g, "<n>")
		.slice(0, 120);
	return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export type CheckLogsOpts = {
	now?: number;
	reAlertMs?: number;
	lookbackMs?: number;
	filterPattern?: string;
	maxGroups?: number;
	excludePrefixes?: string[];
	maxSigsPerGroup?: number;
	maxFindingsPerCycle?: number;
};

export async function checkLogs(
	client: AwsClient,
	state: MonitorState,
	opts: CheckLogsOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const reAlertMs = opts.reAlertMs ?? 86_400_000;
	const lookbackMs = opts.lookbackMs ?? 900_000;
	const filterPattern = opts.filterPattern ?? FILTER_PATTERN;
	const maxGroups = opts.maxGroups ?? MAX_GROUPS;
	const excludePrefixes = opts.excludePrefixes ?? EXCLUDE_PREFIXES;
	const maxSigsPerGroup = opts.maxSigsPerGroup ?? MAX_SIGS_PER_GROUP;
	const maxFindingsPerCycle = opts.maxFindingsPerCycle ?? MAX_FINDINGS_PER_CYCLE;
	const findings: Finding[] = [];
	// (group, signature, count) that hit a cap this cycle: journaled as one
	// info finding so history survives without an investigation storm.
	const overflow: { group: string; signature: string; count: number }[] = [];

	// Paginate: DescribeLogGroups caps pages at 50 and sorts alphabetically,
	// so a single page permanently hides every group after the 50th.
	const groups: string[] = [];
	let nextToken: string | undefined;
	do {
		const resp: any = await client.send(
			new DescribeLogGroupsCommand({ limit: 50, nextToken }),
		);
		for (const g of resp.logGroups ?? []) {
			const name = g.logGroupName;
			if (!name) continue;
			if (excludePrefixes.some((p) => name.startsWith(p))) continue;
			groups.push(name);
		}
		nextToken = resp.nextToken;
	} while (nextToken && groups.length < maxGroups);
	groups.splice(maxGroups);

	// One unreadable group must not kill the scan: a denied group is a scoping
	// fact (name-scoped log IAM), reported once as info, and the rest of the
	// estate still gets scanned this cycle.
	const groupErrors: string[] = [];
	for (const group of groups) {
		const wmKey = `logs:${group}`;
		const since = state.getWatermark(wmKey) ?? now - lookbackMs;
		let resp: any;
		try {
			resp = await client.send(
				new FilterLogEventsCommand({
					logGroupName: group,
					startTime: since,
					endTime: now,
					filterPattern,
				}),
			);
		} catch (e: any) {
			const msg = String(e?.message ?? e);
			if (/not authorized|AccessDenied|UnauthorizedOperation/i.test(msg)) {
				const scopeKey = `logs:scope:${group}:`;
				if (state.shouldAlert(scopeKey)) {
					state.markAlerted(scopeKey, "logs");
					findings.push({
						family: "logs",
						severity: "info",
						resource: group,
						summary: `Log group ${group} is outside the readable name scope (not inspected)`,
						dedup_key: scopeKey,
						evidence: { error: msg.slice(0, 300) },
						at: new Date(now).toISOString(),
					});
				}
			} else {
				groupErrors.push(`${group}: ${msg}`);
			}
			continue;
		}
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

		// Loudest signatures first; everything past the caps is history, not
		// an alert.
		const ranked = [...bySig.entries()].sort((a, b) => b[1].count - a[1].count);
		let emitted = 0;
		for (const [sig, agg] of ranked) {
			const key = `logs:${group}:${sig}`;
			if (!state.shouldAlert(key, reAlertMs)) continue;
			if (emitted >= maxSigsPerGroup || findings.length >= maxFindingsPerCycle) {
				overflow.push({ group, signature: sig, count: agg.count });
				continue;
			}
			state.markAlerted(key, "logs");
			emitted++;
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

	if (overflow.length > 0) {
		findings.push({
			family: "logs",
			severity: "info",
			resource: "logs-overflow",
			summary: `${overflow.length} further error signature(s) over the per-cycle caps (kept in history, not investigated)`,
			dedup_key: `logs:overflow:${new Date(now).toISOString()}`,
			evidence: { overflow },
			at: new Date(now).toISOString(),
		});
	}
	// Non-auth failures on every group is a real check failure, not scoping.
	if (groups.length > 0 && groupErrors.length === groups.length) {
		throw new Error(`all ${groups.length} log group scan(s) failed: ${groupErrors[0]}`);
	}
	return findings;
}
