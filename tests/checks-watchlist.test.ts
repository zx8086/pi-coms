// tests/checks-watchlist.test.ts

import { describe, expect, test } from "bun:test";
import type { LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import { checkWatchlist, DEFAULT_WATCHLIST } from "../scripts/monitor/checks/watchlist.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const NOW = Date.parse("2026-09-01T12:00:00Z");

// Returns hits only for the named events; captures the queried names.
function fakeClient(hits: Record<string, { id: string; user: string }[]>, seen: string[] = []) {
	return {
		seen,
		send: async (cmd: LookupEventsCommand) => {
			const name = cmd.input.LookupAttributes?.[0]?.AttributeValue as string;
			seen.push(name);
			return {
				Events: (hits[name] ?? []).map((h) => ({
					EventId: h.id,
					EventName: name,
					Username: h.user,
					EventTime: new Date(NOW - 1000),
					CloudTrailEvent: JSON.stringify({
						sourceIPAddress: "10.0.0.1",
						userIdentity: { arn: `arn:aws:iam::1:user/${h.user}` },
					}),
					Resources: [],
				})),
			};
		},
	};
}

describe("checkWatchlist", () => {
	test("a watchlist hit is a warn finding with actor evidence", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkWatchlist(
			fakeClient({ StopLogging: [{ id: "e1", user: "mallory" }] }),
			state,
			{ now: NOW, events: ["StopLogging", "DeleteTrail"] },
		);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		expect(out[0].summary).toContain("StopLogging");
		expect(out[0].summary).toContain("mallory");
		expect((out[0].evidence as { sourceIp: string }).sourceIp).toBe("10.0.0.1");
	});

	test("event-id dedup absorbs watermark overlap", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient({ StopLogging: [{ id: "e1", user: "mallory" }] });
		await checkWatchlist(client, state, { now: NOW, events: ["StopLogging"] });
		const again = await checkWatchlist(client, state, { now: NOW + 60_000, events: ["StopLogging"] });
		expect(again).toHaveLength(0);
	});

	test("every configured event name is queried and the watermark advances", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient({});
		await checkWatchlist(client, state, { now: NOW, events: ["StopLogging", "CreateUser"] });
		expect(client.seen).toEqual(["StopLogging", "CreateUser"]);
		expect(state.getWatermark("watchlist")).toBe(NOW);
	});

	test("quiet estate produces nothing", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkWatchlist(fakeClient({}), state, { now: NOW, events: ["StopLogging"] });
		expect(out).toHaveLength(0);
	});

	test("default watchlist covers egress, routing, and S3 exposure writes (SIO-1597)", () => {
		for (const name of [
			"AuthorizeSecurityGroupEgress",
			"RevokeSecurityGroupIngress",
			"RevokeSecurityGroupEgress",
			"CreateRoute",
			"ReplaceRoute",
			"DeleteRoute",
			"DeleteRouteTable",
			"DeleteBucketPolicy",
			"PutPublicAccessBlock",
		]) {
			expect(DEFAULT_WATCHLIST).toContain(name);
		}
		expect(DEFAULT_WATCHLIST).not.toContain("ModifyDBInstance");
	});
});
