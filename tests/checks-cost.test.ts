// tests/checks-cost.test.ts
import { describe, expect, test } from "bun:test";
import { checkCost } from "../scripts/monitor/checks/cost.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(daily: { date: string; usd: number }[]) {
	return {
		async send(cmd: { constructor: { name: string } }) {
			if (cmd.constructor.name !== "GetCostAndUsageCommand") throw new Error("unexpected");
			return {
				ResultsByTime: daily.map((d) => ({
					TimePeriod: { Start: d.date },
					Total: { UnblendedCost: { Amount: String(d.usd), Unit: "USD" } },
				})),
			};
		},
	};
}

// now = 2026-08-30 anywhere in the day; yesterday = 2026-08-29
const NOW = new Date("2026-08-30T08:00:00Z");
function days(baseline: number, yesterday: number) {
	const out: { date: string; usd: number }[] = [];
	for (let d = 15; d >= 2; d--) {
		const dt = new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);
		out.push({ date: dt, usd: baseline });
	}
	out.push({ date: "2026-08-29", usd: yesterday });
	return out;
}

describe("checkCost", () => {
	test("over both thresholds alerts once per day", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient(days(10, 13)); // +30 pct and +3 usd
		const out = await checkCost(client, state, { now: NOW });
		expect(out).toHaveLength(1);
		expect(out[0].dedup_key).toBe("cost:2026-08-29");
		expect(await checkCost(client, state, { now: NOW })).toHaveLength(0);
	});

	test("over pct but under abs stays quiet", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(fakeClient(days(1, 1.5)), state, { now: NOW }); // +50 pct, +0.50 usd
		expect(out).toHaveLength(0);
	});

	test("over abs but under pct stays quiet", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(fakeClient(days(100, 110)), state, { now: NOW }); // +10 usd, +10 pct
		expect(out).toHaveLength(0);
	});

	test("no baseline yet stays quiet but records costs", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(fakeClient([{ date: "2026-08-29", usd: 5 }]), state, { now: NOW });
		expect(out).toHaveLength(0);
		expect(state.latestCost()).toEqual({ date: "2026-08-29", usd: 5 });
	});
});
