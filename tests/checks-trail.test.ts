// tests/checks-trail.test.ts
import { describe, expect, test } from "bun:test";
import { DescribeTrailsCommand } from "@aws-sdk/client-cloudtrail";
import { checkTrail } from "../scripts/monitor/checks/trail.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(trails: { name: string; status: any | Error }[]) {
	return {
		send: async (cmd: any) => {
			if (cmd instanceof DescribeTrailsCommand) {
				return { trailList: trails.map((t) => ({ Name: t.name, TrailARN: `arn:trail/${t.name}` })) };
			}
			const name = (cmd.input.Name as string).replace("arn:trail/", "");
			const t = trails.find((x) => x.name === name);
			if (t?.status instanceof Error) throw t.status;
			return t?.status ?? {};
		},
	};
}

describe("checkTrail", () => {
	test("a trail that stopped logging is critical once", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([{ name: "main", status: { IsLogging: false } }]);
		const first = await checkTrail(client, state);
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("critical");
		expect(first[0].summary).toContain("NOT logging");
		const second = await checkTrail(client, state);
		expect(second).toHaveLength(0);
	});

	test("delivery error is warn; recovery ships info and clears", async () => {
		const state = new MonitorState(":memory:");
		const bad = fakeClient([
			{ name: "main", status: { IsLogging: true, LatestDeliveryError: "AccessDenied to bucket" } },
		]);
		const first = await checkTrail(bad, state);
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("warn");
		const good = fakeClient([{ name: "main", status: { IsLogging: true } }]);
		const rec = await checkTrail(good, state);
		expect(rec).toHaveLength(1);
		expect(rec[0].severity).toBe("info");
		const quiet = await checkTrail(good, state);
		expect(quiet).toHaveLength(0);
	});

	test("healthy trail produces nothing", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkTrail(fakeClient([{ name: "main", status: { IsLogging: true } }]), state);
		expect(out).toHaveLength(0);
	});

	test("no trails at all is an info finding once", async () => {
		const state = new MonitorState(":memory:");
		const first = await checkTrail(fakeClient([]), state);
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("info");
		const second = await checkTrail(fakeClient([]), state);
		expect(second).toHaveLength(0);
	});

	test("one denied shadow trail is tolerated; all failing throws", async () => {
		const state = new MonitorState(":memory:");
		const mixed = fakeClient([
			{ name: "org-shadow", status: new Error("AccessDeniedException") },
			{ name: "local", status: { IsLogging: true } },
		]);
		const out = await checkTrail(mixed, state);
		expect(out).toHaveLength(0);
		const allBad = fakeClient([{ name: "org-shadow", status: new Error("AccessDeniedException") }]);
		await expect(checkTrail(allBad, state)).rejects.toThrow("all 1 trail status read(s) failed");
	});
});
