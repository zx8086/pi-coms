// tests/report.test.ts
import { describe, expect, test } from "bun:test";
import {
	DiagnosisSchema,
	type DigestNotable,
	FindingSchema,
	formatDigest,
	formatIncidentReport,
	notablesFromJournal,
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

const quietDigest = {
	accountId: "111122223333",
	since: "2026-09-02T00:00:00Z",
	findingCounts: {},
	checkErrors: 0,
	activeAlarms: [],
	yesterdayUsd: null,
	baselineUsd: null,
};

const notable = (over: Partial<DigestNotable> = {}): DigestNotable => ({
	severity: "warn" as const,
	family: "drift" as const,
	resource: "i-059a799316e6d8f5d",
	summary: "instance changed state running -> terminated",
	uninvestigated: false,
	...over,
});

describe("digest notables", () => {
	test("names each warn+ finding with severity and family", () => {
		const text = formatDigest({
			...quietDigest,
			findingCounts: { cert: 1, drift: 1 },
			notables: [
				notable({ severity: "critical", family: "cert", resource: "prana-dev.pvhcorp.com", summary: "Certificate prana-dev.pvhcorp.com expires in -979 day(s)" }),
				notable(),
			],
		});
		expect(text).toContain("(critical/cert) prana-dev.pvhcorp.com: Certificate prana-dev.pvhcorp.com expires in -979 day(s)");
		expect(text).toContain("(warn/drift) i-059a799316e6d8f5d: instance changed state running -> terminated");
	});

	test("sorts critical before warn regardless of input order", () => {
		const text = formatDigest({
			...quietDigest,
			findingCounts: { cert: 1, drift: 1 },
			notables: [
				notable({ resource: "warn-first" }),
				notable({ severity: "critical", family: "cert", resource: "crit-second" }),
			],
		});
		expect(text.indexOf("crit-second")).toBeLessThan(text.indexOf("warn-first"));
	});

	test("marks uninvestigated findings on the line and totals them", () => {
		const text = formatDigest({
			...quietDigest,
			findingCounts: { drift: 2 },
			notables: [notable({ uninvestigated: true }), notable({ resource: "i-other" })],
		});
		const line = text.split("\n").find((l) => l.includes("i-059a799316e6d8f5d"));
		expect(line).toContain("[uninvestigated]");
		expect(text).toContain("uninvestigated: 1");
		expect(text.split("\n").find((l) => l.includes("i-other"))).not.toContain("[uninvestigated]");
	});

	test("caps the list at 10 and counts the overflow", () => {
		const notables = Array.from({ length: 13 }, (_, i) => notable({ resource: `i-${i}` }));
		const text = formatDigest({ ...quietDigest, findingCounts: { drift: 13 }, notables });
		expect(text).toContain("i-9");
		expect(text).not.toContain("i-10:");
		expect(text).toContain("+3 more warn+ finding(s)");
	});

	test("uninvestigated total counts findings beyond the display cap", () => {
		const notables = Array.from({ length: 12 }, (_, i) =>
			notable({ resource: `i-${i}`, uninvestigated: i === 11 }),
		);
		const text = formatDigest({ ...quietDigest, findingCounts: { drift: 12 }, notables });
		expect(text).toContain("uninvestigated: 1");
	});

	test("quiet day digest is unchanged: no notable or uninvestigated lines", () => {
		const text = formatDigest({ ...quietDigest, notables: [] });
		expect(text).not.toContain("notable");
		expect(text).not.toContain("uninvestigated");
		expect(text).toBe(formatDigest(quietDigest));
	});

	test("info findings are never listed even if passed", () => {
		const text = formatDigest({
			...quietDigest,
			findingCounts: { drift: 2 },
			notables: [notable({ severity: "info" as never, resource: "i-info" }), notable()],
		});
		expect(text).not.toContain("i-info");
	});
});

describe("notablesFromJournal", () => {
	const row = (payload: unknown) => ({ payload: JSON.stringify(payload) });

	test("keeps warn+ rows, drops info, and maps null diagnosis to uninvestigated", () => {
		const rows = [
			row({ ...finding, diagnosis: null }),
			row({ ...finding, severity: "warn", resource: "warned", diagnosis: { probable_cause: "x", affected_resources: [], suggested_action: "y" } }),
			row({ ...finding, severity: "info", resource: "noise", diagnosis: null }),
		];
		const notables = notablesFromJournal(rows);
		expect(notables).toHaveLength(2);
		expect(notables[0]).toMatchObject({ severity: "critical", resource: "cpu-high", uninvestigated: true });
		expect(notables[1]).toMatchObject({ severity: "warn", resource: "warned", uninvestigated: false });
	});

	test("skips unparseable rows instead of throwing", () => {
		const notables = notablesFromJournal([{ payload: "not json" }, row({ ...finding, diagnosis: null })]);
		expect(notables).toHaveLength(1);
	});
});
