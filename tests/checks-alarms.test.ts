// tests/checks-alarms.test.ts
import { describe, expect, test } from "bun:test";
import { checkAlarms } from "../scripts/monitor/checks/alarms.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(alarms: { AlarmName: string; StateValue: string }[]) {
	return { send: async (_cmd: any) => ({ MetricAlarms: alarms, CompositeAlarms: [] }) };
}

describe("checkAlarms", () => {
	test("transition into ALARM is critical; still-firing does not repeat", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([{ AlarmName: "cpu-high", StateValue: "ALARM" }]);
		const first = await checkAlarms(client, state);
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("critical");
		expect(first[0].dedup_key).toBe("alarm:cpu-high:ALARM");
		const second = await checkAlarms(client, state);
		expect(second).toHaveLength(0);
	});

	test("INSUFFICIENT_DATA is info (designed nightly metric gaps, never investigated)", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkAlarms(fakeClient([{ AlarmName: "a", StateValue: "INSUFFICIENT_DATA" }]), state);
		expect(out[0].severity).toBe("info");
	});

	test("recovery to OK ships info once, then quiet", async () => {
		const state = new MonitorState(":memory:");
		await checkAlarms(fakeClient([{ AlarmName: "cpu-high", StateValue: "ALARM" }]), state);
		const rec = await checkAlarms(fakeClient([{ AlarmName: "cpu-high", StateValue: "OK" }]), state);
		expect(rec).toHaveLength(1);
		expect(rec[0].severity).toBe("info");
		const quiet = await checkAlarms(fakeClient([{ AlarmName: "cpu-high", StateValue: "OK" }]), state);
		expect(quiet).toHaveLength(0);
	});

	test("an alarm that was always OK produces nothing", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkAlarms(fakeClient([{ AlarmName: "fine", StateValue: "OK" }]), state);
		expect(out).toHaveLength(0);
	});

	test("re-entering ALARM after recovery alerts again", async () => {
		const state = new MonitorState(":memory:");
		const alarm = (v: string) => fakeClient([{ AlarmName: "x", StateValue: v }]);
		await checkAlarms(alarm("ALARM"), state);
		await checkAlarms(alarm("OK"), state);
		const again = await checkAlarms(alarm("ALARM"), state);
		expect(again).toHaveLength(1);
	});
});
