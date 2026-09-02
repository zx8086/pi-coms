// scripts/monitor/checks/watchlist.ts
import { LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// Scary write events. The monitor is read-only, so its own CloudTrail echo
// can never match a write watchlist.
export const DEFAULT_WATCHLIST = [
	"StopLogging",
	"DeleteTrail",
	"UpdateTrail",
	"PutBucketPolicy",
	"PutBucketAcl",
	"AuthorizeSecurityGroupIngress",
	"CreateUser",
	"CreateAccessKey",
	"AttachUserPolicy",
	"AttachRolePolicy",
	"PutRolePolicy",
	"PutUserPolicy",
	"DeleteFlowLogs",
	// SIO-1597 additions: egress/revocation, routing, and S3 exposure writes.
	// ModifyDBInstance is deliberately absent; the resource-drift check catches
	// RDS changes within 15 minutes while this list runs daily.
	"AuthorizeSecurityGroupEgress",
	"RevokeSecurityGroupIngress",
	"RevokeSecurityGroupEgress",
	"CreateRoute",
	"ReplaceRoute",
	"DeleteRoute",
	"DeleteRouteTable",
	"DeleteBucketPolicy",
	"PutPublicAccessBlock",
];

const WATERMARK_KEY = "watchlist";
const FIRST_LOOKBACK_MS = 86_400_000;

export type CheckWatchlistOpts = { now?: number; events?: string[] };

export async function checkWatchlist(
	client: AwsClient,
	state: MonitorState,
	opts: CheckWatchlistOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const events = opts.events ?? DEFAULT_WATCHLIST;
	const since = state.getWatermark(WATERMARK_KEY) ?? now - FIRST_LOOKBACK_MS;
	const findings: Finding[] = [];
	const at = new Date(now).toISOString();

	// LookupEvents takes exactly one attribute per call, so it is one
	// sequential call per watched name (the API is throttled to ~2 TPS).
	// The watermark advances only after a fully successful pass; overlap on a
	// partial pass is absorbed by the per-event-id dedup.
	for (const name of events) {
		let nextToken: string | undefined;
		do {
			const resp: any = await client.send(
				new LookupEventsCommand({
					LookupAttributes: [{ AttributeKey: "EventName", AttributeValue: name }],
					StartTime: new Date(since),
					EndTime: new Date(now),
					NextToken: nextToken,
				}),
			);
			for (const e of resp.Events ?? []) {
				const id: string = e.EventId ?? "unknown";
				const key = `watch:${name}:${id}`;
				if (!state.shouldAlert(key)) continue;
				state.markAlerted(key, "watchlist");
				let detail: any = {};
				try {
					detail = JSON.parse(e.CloudTrailEvent ?? "{}");
				} catch {
					// raw event stays in evidence via the summary fields
				}
				findings.push({
					family: "watchlist",
					severity: "warn",
					resource: e.Resources?.[0]?.ResourceName ?? name,
					summary: `Watchlist event ${name} by ${e.Username ?? detail?.userIdentity?.arn ?? "unknown"}`,
					dedup_key: key,
					evidence: {
						eventId: id,
						eventTime: e.EventTime ? new Date(e.EventTime).toISOString() : null,
						username: e.Username ?? null,
						sourceIp: detail?.sourceIPAddress ?? null,
						userArn: detail?.userIdentity?.arn ?? null,
						resources: (e.Resources ?? []).map((r: any) => r.ResourceName).filter(Boolean),
					},
					at,
				});
			}
			nextToken = resp.NextToken;
		} while (nextToken);
	}
	state.setWatermark(WATERMARK_KEY, now);
	return findings;
}
