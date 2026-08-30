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
