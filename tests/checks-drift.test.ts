// tests/checks-drift.test.ts
import { describe, expect, test } from "bun:test";
import { checkDrift } from "../scripts/monitor/checks/drift.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(
	instances: { id: string; state: string }[],
	statuses: { id: string; system: string; instance: string }[] = [],
) {
	return {
		async send(cmd: any) {
			if (cmd.constructor.name === "DescribeInstancesCommand") {
				return {
					Reservations: [{
						Instances: instances.map((i) => ({ InstanceId: i.id, State: { Name: i.state } })),
					}],
				};
			}
			if (cmd.constructor.name === "DescribeInstanceStatusCommand") {
				return {
					InstanceStatuses: statuses.map((s) => ({
						InstanceId: s.id,
						SystemStatus: { Status: s.system },
						InstanceStatus: { Status: s.instance },
					})),
				};
			}
			throw new Error(`unexpected ${cmd.constructor.name}`);
		},
	};
}

describe("checkDrift", () => {
	test("first run establishes the baseline silently", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state);
		expect(out).toHaveLength(0);
		expect(state.getSnapshot("instances")).toEqual({ "i-1": "running" });
	});

	test("running to stopped is warn, once", async () => {
		const state = new MonitorState(":memory:");
		await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state);
		const out = await checkDrift(fakeClient([{ id: "i-1", state: "stopped" }]), state);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		const again = await checkDrift(fakeClient([{ id: "i-1", state: "stopped" }]), state);
		expect(again).toHaveLength(0);
	});

	test("disappeared instance is warn; new instance is info", async () => {
		const state = new MonitorState(":memory:");
		await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state);
		const out = await checkDrift(fakeClient([{ id: "i-2", state: "running" }]), state);
		const sevs = out.map((f) => `${f.resource}:${f.severity}`).sort();
		expect(sevs).toEqual(["i-1:warn", "i-2:info"]);
	});

	test("failed status check is warn once and clears on recovery", async () => {
		const state = new MonitorState(":memory:");
		const bad = fakeClient(
			[{ id: "i-1", state: "running" }],
			[{ id: "i-1", system: "impaired", instance: "ok" }],
		);
		await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state); // baseline
		const out = await checkDrift(bad, state);
		expect(out).toHaveLength(1);
		expect(out[0].summary).toContain("status check");
		expect(await checkDrift(bad, state)).toHaveLength(0);
		const good = fakeClient(
			[{ id: "i-1", state: "running" }],
			[{ id: "i-1", system: "ok", instance: "ok" }],
		);
		await checkDrift(good, state);
		const badAgain = await checkDrift(bad, state);
		expect(badAgain).toHaveLength(1);
	});
});
