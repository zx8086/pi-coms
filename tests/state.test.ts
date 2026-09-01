// tests/state.test.ts
import { describe, expect, test } from "bun:test";
import { MonitorState } from "../scripts/monitor/state.ts";

describe("MonitorState", () => {
	test("watermarks round-trip", () => {
		const s = new MonitorState(":memory:");
		expect(s.getWatermark("logs:/aws/x")).toBeNull();
		s.setWatermark("logs:/aws/x", 1000);
		s.setWatermark("logs:/aws/x", 2000);
		expect(s.getWatermark("logs:/aws/x")).toBe(2000);
	});

	test("fingerprints: alert once until cleared", () => {
		const s = new MonitorState(":memory:");
		expect(s.shouldAlert("alarm:a:ALARM")).toBe(true);
		s.markAlerted("alarm:a:ALARM", "alarm");
		expect(s.shouldAlert("alarm:a:ALARM")).toBe(false);
		expect(s.alertKeys("alarm:a:")).toEqual(["alarm:a:ALARM"]);
		s.clearAlerts("alarm:a:");
		expect(s.shouldAlert("alarm:a:ALARM")).toBe(true);
	});

	test("fingerprints: re-alert window", () => {
		const s = new MonitorState(":memory:");
		s.markAlerted("logs:g:sig", "logs");
		expect(s.shouldAlert("logs:g:sig", 60_000)).toBe(false);
		expect(s.shouldAlert("logs:g:sig", -1)).toBe(true); // window already elapsed
	});

	test("snapshots round-trip JSON", () => {
		const s = new MonitorState(":memory:");
		expect(s.getSnapshot("instances")).toBeNull();
		s.setSnapshot("instances", { "i-1": "running" });
		expect(s.getSnapshot("instances")).toEqual({ "i-1": "running" });
	});

	test("cost baseline is the mean of prior days, excluding the target day", () => {
		const s = new MonitorState(":memory:");
		expect(s.costBaseline("2026-08-30", 14)).toBeNull();
		for (let d = 1; d <= 14; d++) s.recordCost(`2026-08-${String(d).padStart(2, "0")}`, 1.0);
		s.recordCost("2026-08-30", 99);
		expect(s.costBaseline("2026-08-30", 14)).toBeCloseTo(1.0);
	});

	test("journal and prior incidents", () => {
		const s = new MonitorState(":memory:");
		s.journal("finding", { resource: "cpu-high", summary: "went ALARM" });
		s.journal("finding", { resource: "other", summary: "x" });
		s.journal("run", { ok: true });
		expect(s.journalRows(60_000)).toHaveLength(3);
		expect(s.journalRows(60_000, "finding")).toHaveLength(2);
		const prior = s.priorIncidents("cpu-high", 5);
		expect(prior).toHaveLength(1);
		expect(prior[0].payload).toContain("went ALARM");
	});

	test("unsent queue", () => {
		const s = new MonitorState(":memory:");
		s.queueUnsent("laptop", "report", 1000);
		const rows = s.unsent();
		expect(rows).toHaveLength(1);
		expect(rows[0].target).toBe("laptop");
		s.deleteUnsent(rows[0].id);
		expect(s.unsent()).toHaveLength(0);
	});
});

describe("suppression ledger", () => {
	test("LIKE patterns match dedup keys with wildcards", () => {
		const s = new MonitorState(":memory:");
		s.addSuppression("alarm:%-Utilization-Low-20%", "accepted rightsizing noise");
		const m = s.matchSuppression("alarm:svc-a-Utilization-Low-20:ALARM");
		expect(m?.reason).toBe("accepted rightsizing noise");
		expect(s.matchSuppression("alarm:cpu-high:ALARM")).toBeNull();
	});

	test("add is upsert, remove reports whether anything matched", () => {
		const s = new MonitorState(":memory:");
		s.addSuppression("logs:/ecs/app:%", "first");
		s.addSuppression("logs:/ecs/app:%", "updated");
		expect(s.listSuppressions()).toHaveLength(1);
		expect(s.listSuppressions()[0].reason).toBe("updated");
		expect(s.removeSuppression("logs:/ecs/app:%")).toBe(true);
		expect(s.removeSuppression("logs:/ecs/app:%")).toBe(false);
		expect(s.matchSuppression("logs:/ecs/app:abc")).toBeNull();
	});
});

test("pruneJournal removes only rows past retention", () => {
	const s = new MonitorState(":memory:");
	s.journal("finding", { old: true });
	// Backdate the row well past a 1 ms retention window.
	(s as any).db.query("UPDATE journal SET ts_ms = ts_ms - 100000").run();
	s.journal("finding", { fresh: true });
	const removed = s.pruneJournal(50_000);
	expect(removed).toBe(1);
	expect(s.journalRows(86_400_000, "finding")).toHaveLength(1);
});
