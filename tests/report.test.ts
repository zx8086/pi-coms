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
