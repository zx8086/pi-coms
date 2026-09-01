// tests/report.test.ts
import { describe, expect, test } from "bun:test";
import {
	DiagnosisSchema,
	FindingSchema,
	formatDigest,
	formatIncidentReport,
	parseDiagnoses,
} from "../scripts/monitor/report.ts";

const finding = {
	family: "alarm" as const,
	severity: "critical" as const,
	resource: "cpu-high",
	summary: "Alarm cpu-high entered ALARM",
	dedup_key: "alarm:cpu-high:ALARM",
	evidence: { state: "ALARM" },
	at: "2026-08-30T00:00:00.000Z",
};

describe("report", () => {
	test("FindingSchema accepts a finding and rejects bad severity", () => {
		expect(FindingSchema.safeParse(finding).success).toBe(true);
		expect(FindingSchema.safeParse({ ...finding, severity: "bad" }).success).toBe(false);
	});

	test("parseDiagnoses maps by dedup_key and rejects garbage", () => {
		const good = {
			diagnoses: [{
				dedup_key: "alarm:cpu-high:ALARM",
				probable_cause: "load spike",
				affected_resources: ["i-123"],
				suggested_action: "check autoscaling",
			}],
		};
		const map = parseDiagnoses(good);
		expect(map?.get("alarm:cpu-high:ALARM")?.probable_cause).toBe("load spike");
		expect(parseDiagnoses("not json shaped")).toBeNull();
		expect(parseDiagnoses({ diagnoses: [{ nope: 1 }] })).toBeNull();
	});

	test("incident report leads with severity and includes diagnosis", () => {
		const diag = DiagnosisSchema.parse({
			probable_cause: "load spike",
			affected_resources: ["i-123"],
			suggested_action: "check autoscaling",
		});
		const text = formatIncidentReport("111122223333", [{ finding, diagnosis: diag }]);
		expect(text.startsWith("[critical]")).toBe(true);
		expect(text).toContain("cpu-high");
		expect(text).toContain("load spike");
	});

	test("uninvestigated findings carry a marker", () => {
		const text = formatIncidentReport("111122223333", [{ finding, diagnosis: null }]);
		expect(text).toContain("uninvestigated");
	});

	test("digest renders even when quiet", () => {
		const text = formatDigest({
			accountId: "111122223333",
			since: "2026-08-29T00:00:00Z",
			findingCounts: {},
			checkErrors: 0,
			activeAlarms: [],
			yesterdayUsd: 1.23,
			baselineUsd: 1.1,
		});
		expect(text).toContain("daily digest");
		expect(text).toContain("no findings");
		expect(text).toContain("1.23");
	});
});

test("digest names the failing check family next to the error count", () => {
	const text = formatDigest({
		accountId: "111122223333",
		since: "2026-08-31T00:00:00Z",
		findingCounts: {},
		checkErrors: 26,
		checkErrorsByCheck: { logs: 26 },
		activeAlarms: [],
		yesterdayUsd: null,
		baselineUsd: null,
	});
	expect(text).toContain("check errors: 26 (logs=26)");
});

test("digest flags DEGRADED in the header when checks errored", () => {
	const text = formatDigest({
		accountId: "111122223333",
		since: "2026-08-31T00:00:00Z",
		findingCounts: {},
		checkErrors: 3,
		activeAlarms: [],
		yesterdayUsd: null,
		baselineUsd: null,
	});
	expect(text.split("\n")[0]).toContain("[warn]");
	expect(text.split("\n")[0]).toContain("DEGRADED: 3 check error(s)");
});

test("digest carries the bundle canary and suppressed count", () => {
	const text = formatDigest({
		accountId: "111122223333",
		since: "2026-08-31T00:00:00Z",
		findingCounts: {},
		checkErrors: 0,
		activeAlarms: [],
		yesterdayUsd: null,
		baselineUsd: null,
		bundleVersion: "5f5d7b2",
		suppressedCount: 4,
	});
	expect(text).toContain("bundle: 5f5d7b2");
	expect(text).toContain("suppressed by ledger: 4");
	const unknown = formatDigest({
		accountId: "111122223333",
		since: "2026-08-31T00:00:00Z",
		findingCounts: {},
		checkErrors: 0,
		activeAlarms: [],
		yesterdayUsd: null,
		baselineUsd: null,
	});
	expect(unknown).toContain("bundle: unknown");
});

test("incident report footnotes the suppressed count", () => {
	const text = formatIncidentReport("111122223333", [{ finding, diagnosis: null }], null, 2);
	expect(text).toContain("suppressed: 2 finding(s) matching the ledger");
});

test("uninvestigated marker carries the concrete failure reason when known", () => {
	const text = formatIncidentReport(
		"111122223333",
		[{ finding, diagnosis: null }],
		"agent reply error: response not valid JSON",
	);
	expect(text).toContain("uninvestigated: agent reply error: response not valid JSON");
});
