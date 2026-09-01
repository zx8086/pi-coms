// tests/checks-logs.test.ts
import { describe, expect, test } from "bun:test";
import { checkLogs, logSignature } from "../scripts/monitor/checks/logs.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(
	groups: string[],
	eventsByGroup: Record<string, { timestamp: number; message: string }[]>,
) {
	return {
		calls: [] as any[],
		async send(cmd: any) {
			this.calls.push(cmd);
			if (cmd.constructor.name === "DescribeLogGroupsCommand") {
				return { logGroups: groups.map((g) => ({ logGroupName: g })) };
			}
			if (cmd.constructor.name === "FilterLogEventsCommand") {
				const g = cmd.input.logGroupName as string;
				const since = cmd.input.startTime as number;
				return { events: (eventsByGroup[g] ?? []).filter((e) => e.timestamp >= since) };
			}
			throw new Error(`unexpected ${cmd.constructor.name}`);
		},
	};
}

describe("checkLogs", () => {
	test("signature is stable across ids and timestamps", () => {
		const a = logSignature("ERROR order 12345 failed at 2026-08-30T10:00:00Z req 6f9a0c2b4d1e8f37");
		const b = logSignature("ERROR order 99999 failed at 2026-08-31T11:11:11Z req deadbeefcafe0123");
		expect(a).toBe(b);
		expect(logSignature("WARN disk low")).not.toBe(a);
	});

	test("errors since the watermark become one grouped finding; watermark advances", async () => {
		const state = new MonitorState(":memory:");
		const now = 1_000_000_000_000;
		const client = fakeClient(["/aws/app"], {
			"/aws/app": [
				{ timestamp: now - 60_000, message: "ERROR db connect failed 1" },
				{ timestamp: now - 30_000, message: "ERROR db connect failed 2" },
			],
		});
		const out = await checkLogs(client, state, { now });
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		expect((out[0].evidence as any).count).toBe(2);
		expect(state.getWatermark("logs:/aws/app")).toBe(now - 30_000 + 1);
	});

	test("second run with no new events is quiet; same signature within window is deduped", async () => {
		const state = new MonitorState(":memory:");
		const now = 1_000_000_000_000;
		const events = [{ timestamp: now - 60_000, message: "ERROR x failed" }];
		await checkLogs(fakeClient(["/g"], { "/g": events }), state, { now });
		// new event, same signature, later timestamp
		const later = [{ timestamp: now + 10_000, message: "ERROR x failed" }];
		const out = await checkLogs(fakeClient(["/g"], { "/g": later }), state, { now: now + 20_000 });
		expect(out).toHaveLength(0); // fingerprinted
		expect(state.getWatermark("logs:/g")).toBe(now + 10_000 + 1);
	});

	test("first run only looks back lookbackMs", async () => {
		const state = new MonitorState(":memory:");
		const now = 1_000_000_000_000;
		const client = fakeClient(["/g"], {
			"/g": [{ timestamp: now - 3_600_000, message: "ERROR ancient" }],
		});
		const out = await checkLogs(client, state, { now, lookbackMs: 900_000 });
		expect(out).toHaveLength(0);
	});
});

describe("checkLogs relevance caps", () => {
	const now = 1_000_000_000_000;
	const ev = (msg: string, i = 0) => ({ timestamp: now - 60_000 + i, message: msg });

	test("excluded prefixes are never scanned", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient(["/aws/codebuild/x", "/aws/app"], {
			"/aws/codebuild/x": [ev("ERROR noisy build")],
			"/aws/app": [ev("ERROR real problem")],
		});
		const out = await checkLogs(client, state, { now, excludePrefixes: ["/aws/codebuild/"] });
		expect(out).toHaveLength(1);
		expect(out[0].resource).toBe("/aws/app");
	});

	test("per-group cap keeps loudest signatures, folds the rest into one info overflow", async () => {
		const state = new MonitorState(":memory:");
		const events = [
			ev("ERROR alpha broke", 1), ev("ERROR alpha broke", 2), ev("ERROR alpha broke", 3),
			ev("ERROR beta broke", 4), ev("ERROR beta broke", 5),
			ev("ERROR gamma broke", 6), ev("ERROR gamma broke", 7),
			ev("ERROR delta broke", 8),
			ev("ERROR epsilon broke", 9),
		];
		const client = fakeClient(["/aws/app"], { "/aws/app": events });
		const out = await checkLogs(client, state, { now, maxSigsPerGroup: 3 });
		const warns = out.filter((f) => f.severity === "warn");
		const infos = out.filter((f) => f.severity === "info");
		expect(warns).toHaveLength(3);
		expect((warns[0].evidence as any).count).toBe(3); // loudest first
		expect(infos).toHaveLength(1);
		expect((infos[0].evidence as any).overflow).toHaveLength(2);
	});

	test("per-cycle cap bounds warn findings across groups", async () => {
		const state = new MonitorState(":memory:");
		const groups = ["/g1", "/g2", "/g3"];
		const byGroup: Record<string, { timestamp: number; message: string }[]> = {};
		for (const g of groups) byGroup[g] = [ev(`ERROR ${g} one`), ev(`ERROR ${g} two x`)];
		const client = fakeClient(groups, byGroup);
		const out = await checkLogs(client, state, { now, maxFindingsPerCycle: 4 });
		expect(out.filter((f) => f.severity === "warn")).toHaveLength(4);
		expect(out.filter((f) => f.severity === "info")).toHaveLength(1);
	});

	test("default filter pattern excludes WARN", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient(["/aws/app"], { "/aws/app": [ev("ERROR x")] });
		await checkLogs(client, state, { now });
		const filterCall = client.calls.find((c: any) => c.constructor.name === "FilterLogEventsCommand");
		expect(filterCall.input.filterPattern).toBe("?ERROR ?Exception");
	});
});

describe("checkLogs noise controls (SIO-1590)", () => {
	const now = 1_000_000_000_000;

	test("UUIDs normalize to a stable signature", () => {
		const a = logSignature('{"id":"d41c3231-612b-fc56-b455-b41b62a98d89","detail-type":"AWS API Call"} ERROR');
		const b = logSignature('{"id":"bd1480c6-3363-32ba-2d95-53a9b323fded","detail-type":"AWS API Call"} ERROR');
		expect(a).toBe(b);
	});

	test("/aws/events/ groups are excluded by default; explicit opt-in overrides", async () => {
		const events = [{ timestamp: now - 60_000, message: "ERROR delivery echo" }];
		const groups = ["/aws/events/eventbridge-logs"];
		const byGroup = { "/aws/events/eventbridge-logs": events };

		const out = await checkLogs(fakeClient(groups, byGroup), new MonitorState(":memory:"), { now });
		expect(out).toHaveLength(0);

		const optIn = await checkLogs(fakeClient(groups, byGroup), new MonitorState(":memory:"), {
			now,
			excludePrefixes: [],
		});
		expect(optIn).toHaveLength(1);
	});
});
