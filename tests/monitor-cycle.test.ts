// tests/monitor-cycle.test.ts
import { describe, expect, test } from "bun:test";
import { investigateBudgetMs, makeGuard, runCycle, type CycleDeps } from "../scripts/coms-net-monitor.ts";
import type { Finding } from "../scripts/monitor/report.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const F = (over: Partial<Finding> = {}): Finding => ({
	family: "alarm",
	severity: "critical",
	resource: "cpu",
	summary: "alarm fired",
	dedup_key: "alarm:cpu:ALARM",
	evidence: {},
	at: new Date().toISOString(),
	...over,
});

function deps(over: Partial<CycleDeps> = {}): CycleDeps & { sent: string[] } {
	const sent: string[] = [];
	return {
		sent,
		checks: [{ name: "alarms", run: async () => [F()] }],
		state: new MonitorState(":memory:"),
		investigate: async () => ({
			diagnoses: new Map([
				["alarm:cpu:ALARM", { probable_cause: "load", affected_resources: [], suggested_action: "scale" }],
			]),
			failure: null,
		}),
		report: async (text: string) => {
			sent.push(text);
		},
		log: () => {},
		...over,
	};
}

describe("runCycle", () => {
	test("findings are investigated, reported, and journaled", async () => {
		const d = deps();
		const out = await runCycle(d);
		expect(out.findings).toHaveLength(1);
		expect(d.sent).toHaveLength(1);
		expect(d.sent[0]).toContain("load");
		expect(d.state.journalRows(60_000, "finding")).toHaveLength(1);
	});

	test("investigation failure still ships the raw finding", async () => {
		const d = deps({ investigate: async () => ({ diagnoses: null, failure: null }) });
		await runCycle(d);
		expect(d.sent[0]).toContain("uninvestigated");
	});

	test("info-only findings skip investigation but still report", async () => {
		let investigated = false;
		const d = deps({
			checks: [{ name: "alarms", run: async () => [F({ severity: "info", dedup_key: "alarm:cpu:OK" })] }],
			investigate: async () => {
				investigated = true;
				return new Map();
			},
		});
		await runCycle(d);
		expect(investigated).toBe(false);
		expect(d.sent).toHaveLength(1);
	});

	test("a throwing check is journaled and the rest still run", async () => {
		const d = deps({
			checks: [
				{
					name: "boom",
					run: async () => {
						throw new Error("throttled");
					},
				},
				{ name: "alarms", run: async () => [F()] },
			],
		});
		const out = await runCycle(d);
		expect(out.findings).toHaveLength(1);
		expect(d.state.journalRows(60_000, "check_error")).toHaveLength(1);
	});

	test("failed report is queued unsent and retried next cycle", async () => {
		let fail = true;
		const sent: string[] = [];
		const d = deps({
			report: async (text: string) => {
				if (fail) throw new Error("hub down");
				sent.push(text);
			},
		});
		await runCycle(d);
		expect(d.state.unsent()).toHaveLength(1);
		fail = false;
		// no findings this cycle; retry path only
		d.checks = [{ name: "alarms", run: async () => [] }];
		await runCycle(d);
		expect(sent).toHaveLength(1);
		expect(d.state.unsent()).toHaveLength(0);
	});

	test("quiet cycle sends nothing", async () => {
		const d = deps({ checks: [{ name: "alarms", run: async () => [] }] });
		await runCycle(d);
		expect(d.sent).toHaveLength(0);
	});

	test("an unhealthy gate skips the checks and reports only the gate finding", async () => {
		let checksRan = false;
		const gateFinding = F({
			family: "identity",
			dedup_key: "identity:error",
			summary: "Identity check failed: ExpiredToken",
		});
		const d = deps({
			gate: { name: "identity", run: async () => ({ findings: [gateFinding], healthy: false }) },
			checks: [
				{
					name: "alarms",
					run: async () => {
						checksRan = true;
						return [F()];
					},
				},
			],
		});
		const out = await runCycle(d);
		expect(checksRan).toBe(false);
		expect(out.findings).toHaveLength(1);
		expect(out.findings[0].family).toBe("identity");
		expect(d.sent[0]).toContain("Identity check failed");
	});

	test("a healthy gate lets the checks run", async () => {
		const d = deps({ gate: { name: "identity", run: async () => ({ findings: [], healthy: true }) } });
		const out = await runCycle(d);
		expect(out.findings).toHaveLength(1);
	});

	test("a throwing gate is a check error, not a skip", async () => {
		const d = deps({
			gate: {
				name: "identity",
				run: async () => {
					throw new Error("sdk bug");
				},
			},
		});
		const out = await runCycle(d);
		expect(out.findings).toHaveLength(1);
		expect(d.state.journalRows(60_000, "check_error")).toHaveLength(1);
	});

	test("ledger-matched findings are journaled, not investigated, not reported", async () => {
		let investigated = false;
		const d = deps({
			investigate: async () => {
				investigated = true;
				return { diagnoses: null, failure: null };
			},
		});
		d.state.addSuppression("alarm:cpu:%", "accepted dev rightsizing noise");
		const out = await runCycle(d);
		expect(investigated).toBe(false);
		expect(out.findings).toHaveLength(0);
		expect(out.suppressed).toBe(1);
		expect(d.sent).toHaveLength(0);
		expect(d.state.journalRows(60_000, "suppressed_finding")).toHaveLength(1);
	});

	test("suppressed count rides the report as a footnote when other findings ship", async () => {
		const d = deps({
			checks: [
				{
					name: "alarms",
					run: async () => [F(), F({ dedup_key: "alarm:noisy:ALARM", resource: "noisy" })],
				},
			],
		});
		d.state.addSuppression("alarm:noisy:%", "known flap");
		const out = await runCycle(d);
		expect(out.findings).toHaveLength(1);
		expect(out.suppressed).toBe(1);
		expect(d.sent[0]).toContain("suppressed: 1 finding(s)");
		expect(d.sent[0]).not.toContain("noisy:");
	});
});

describe("makeGuard", () => {
	test("separate guards never starve each other (midnight collision)", async () => {
		// @daily always coincides with a */15 boundary; the check and daily jobs
		// must therefore hold DIFFERENT guards or the digest is silently skipped.
		const checkGuard = makeGuard();
		const dailyGuard = makeGuard();
		let dailyRan = false;
		await Promise.all([
			checkGuard(async () => {
				await Bun.sleep(50);
			}),
			dailyGuard(async () => {
				dailyRan = true;
			}),
		]);
		expect(dailyRan).toBe(true);
	});

	test("overlapping invocations are skipped, not queued", async () => {
		const guard = makeGuard();
		let running = 0;
		let ran = 0;
		const slow = async () => {
			running++;
			ran++;
			expect(running).toBe(1);
			await Bun.sleep(50);
			running--;
		};
		await Promise.all([guard(slow), guard(slow), guard(slow)]);
		expect(ran).toBe(1);
	});
});

test("investigation failure reason reaches the report", async () => {
	const d = deps({
		investigate: async () => ({ diagnoses: null, failure: "agent reply error: response not valid JSON" }),
	});
	await runCycle(d);
	expect(d.sent[0]).toContain("uninvestigated: agent reply error: response not valid JSON");
});

describe("investigateBudgetMs", () => {
	test("scales with the finding count from the base", () => {
		expect(investigateBudgetMs(0, 300_000, 60_000, 1_800_000)).toBe(300_000);
		expect(investigateBudgetMs(1, 300_000, 60_000, 1_800_000)).toBe(360_000);
		expect(investigateBudgetMs(19, 300_000, 60_000, 1_800_000)).toBe(1_440_000);
	});

	test("caps at the max so a huge batch cannot stall cycles", () => {
		expect(investigateBudgetMs(45, 300_000, 60_000, 1_800_000)).toBe(1_800_000);
		expect(investigateBudgetMs(1_000, 300_000, 60_000, 1_800_000)).toBe(1_800_000);
	});
});
