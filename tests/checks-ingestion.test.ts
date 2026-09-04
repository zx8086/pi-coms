// tests/checks-ingestion.test.ts
import { describe, expect, test } from "bun:test";
import { checkIngestion } from "../scripts/monitor/checks/ingestion.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const HOUR = 3_600_000;
// Fixed "now" 10 minutes past an hour boundary; the check observes the last
// full hour before that boundary.
const NOW = Math.floor(Date.parse("2026-09-01T12:00:00Z") / HOUR) * HOUR + 600_000;
const LAST_HOUR = Math.floor(NOW / HOUR) * HOUR - HOUR;

// Builds one MetricDataResults series per group from {offsetHours: value}.
function fakeClient(groups: Record<string, Record<number, number>>) {
	return {
		send: async () => ({
			MetricDataResults: Object.entries(groups).map(([label, points]) => ({
				Label: label,
				Timestamps: Object.keys(points).map((h) => new Date(LAST_HOUR - Number(h) * HOUR)),
				Values: Object.values(points),
			})),
		}),
	};
}

// A group chatty at this hour on each of the prior 7 days.
const activeBaseline = (lastHourValue: number): Record<number, number> => {
	const p: Record<number, number> = { 0: lastHourValue };
	for (let d = 1; d <= 7; d++) p[d * 24] = 100;
	return p;
};

describe("checkIngestion", () => {
	test("a normally-active group at zero warns once", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient({ "/ecs/api": activeBaseline(0) });
		const first = await checkIngestion(client, state, { now: NOW });
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("warn");
		expect(first[0].summary).toContain("stopped");
		const second = await checkIngestion(client, state, { now: NOW });
		expect(second).toHaveLength(0);
	});

	test("ingestion present produces nothing", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkIngestion(fakeClient({ "/ecs/api": activeBaseline(80) }), state, { now: NOW });
		expect(out).toHaveLength(0);
	});

	test("nightly scale-to-zero is silent: same-hour baseline is zero", async () => {
		const state = new MonitorState(":memory:");
		// Quiet at this hour every day; volume elsewhere is irrelevant.
		const points: Record<number, number> = { 0: 0 };
		for (let d = 1; d <= 7; d++) points[d * 24] = 0;
		const out = await checkIngestion(fakeClient({ "/ecs/nightly": points }), state, { now: NOW });
		expect(out).toHaveLength(0);
	});

	test("recovery ships one info finding and clears", async () => {
		const state = new MonitorState(":memory:");
		await checkIngestion(fakeClient({ "/ecs/api": activeBaseline(0) }), state, { now: NOW });
		const rec = await checkIngestion(fakeClient({ "/ecs/api": activeBaseline(55) }), state, { now: NOW });
		expect(rec).toHaveLength(1);
		expect(rec[0].severity).toBe("info");
		expect(rec[0].summary).toContain("resumed");
		const quiet = await checkIngestion(fakeClient({ "/ecs/api": activeBaseline(55) }), state, { now: NOW });
		expect(quiet).toHaveLength(0);
	});

	test("excluded prefixes are skipped", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkIngestion(fakeClient({ "/aws/events/trail": activeBaseline(0) }), state, { now: NOW });
		expect(out).toHaveLength(0);
	});

	test("a low-volume group below the median floor never alerts", async () => {
		const state = new MonitorState(":memory:");
		const points: Record<number, number> = { 0: 0 };
		for (let d = 1; d <= 7; d++) points[d * 24] = 3; // median 3 < default floor 10
		const out = await checkIngestion(fakeClient({ "/ecs/sparse": points }), state, { now: NOW });
		expect(out).toHaveLength(0);
	});

	test("nested group names do not cross-clear fingerprints", async () => {
		const state = new MonitorState(":memory:");
		// /ecs/a silent, /ecs/a-b healthy: recovery/clear on one must not
		// touch the other.
		await checkIngestion(fakeClient({ "/ecs/a": activeBaseline(0), "/ecs/a-b": activeBaseline(50) }), state, {
			now: NOW,
		});
		const rec = await checkIngestion(
			fakeClient({ "/ecs/a": activeBaseline(60), "/ecs/a-b": activeBaseline(50) }),
			state,
			{ now: NOW },
		);
		expect(rec).toHaveLength(1);
		expect(rec[0].resource).toBe("/ecs/a");
	});
});
