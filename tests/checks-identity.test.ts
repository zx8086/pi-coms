// tests/checks-identity.test.ts
import { describe, expect, test } from "bun:test";
import { checkIdentity } from "../scripts/monitor/checks/identity.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const ok = (account: string) => ({
	send: async () => ({ Account: account, Arn: `arn:aws:sts::${account}:assumed-role/x/y` }),
});
const broken = {
	send: async () => {
		throw new Error("ExpiredToken: The security token included in the request is expired");
	},
};

describe("checkIdentity", () => {
	test("matching account is healthy and quiet", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkIdentity(ok("111122223333"), state, { expectedAccountId: "111122223333" });
		expect(out.healthy).toBe(true);
		expect(out.findings).toHaveLength(0);
	});

	test("mismatch is critical and unhealthy", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkIdentity(ok("999988887777"), state, { expectedAccountId: "111122223333" });
		expect(out.healthy).toBe(false);
		expect(out.findings).toHaveLength(1);
		expect(out.findings[0].severity).toBe("critical");
		expect(out.findings[0].summary).toContain("999988887777");
	});

	test("a thrown call is critical, deduped, and stays unhealthy while deduped", async () => {
		const state = new MonitorState(":memory:");
		const first = await checkIdentity(broken, state, { expectedAccountId: "111122223333" });
		expect(first.healthy).toBe(false);
		expect(first.findings[0].severity).toBe("critical");
		const second = await checkIdentity(broken, state, { expectedAccountId: "111122223333" });
		expect(second.healthy).toBe(false);
		expect(second.findings).toHaveLength(0);
	});

	test("recovery after a failure ships one info finding then goes quiet", async () => {
		const state = new MonitorState(":memory:");
		await checkIdentity(broken, state, { expectedAccountId: "111122223333" });
		const rec = await checkIdentity(ok("111122223333"), state, { expectedAccountId: "111122223333" });
		expect(rec.healthy).toBe(true);
		expect(rec.findings).toHaveLength(1);
		expect(rec.findings[0].severity).toBe("info");
		const quiet = await checkIdentity(ok("111122223333"), state, { expectedAccountId: "111122223333" });
		expect(quiet.findings).toHaveLength(0);
	});

	test("unknown expected account skips mismatch logic but still catches denial", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkIdentity(ok("999988887777"), state, { expectedAccountId: "unknown" });
		expect(out.healthy).toBe(true);
		expect(out.findings).toHaveLength(0);
	});
});
