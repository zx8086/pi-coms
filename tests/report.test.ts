// tests/report.test.ts
import { describe, expect, test } from "bun:test";
import {
	DiagnosisSchema,
	type DigestNotable,
	FindingSchema,
	formatDigest,
	formatIncidentReport,
	formatSuppressionReview,
	notablesFromJournal,
	parseDiagnoses,
	suppressionReviewFromJournal,
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
			diagnoses: [
				{
					dedup_key: "alarm:cpu-high:ALARM",
					probable_cause: "load spike",
					affected_resources: ["i-123"],
					suggested_action: "check autoscaling",
				},
			],
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
				notable({
					severity: "critical",
					family: "cert",
					resource: "prana-dev.pvhcorp.com",
					summary: "Certificate prana-dev.pvhcorp.com expires in -979 day(s)",
				}),
				notable(),
			],
		});
		expect(text).toContain(
			"(critical/cert) prana-dev.pvhcorp.com: Certificate prana-dev.pvhcorp.com expires in -979 day(s)",
		);
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

	test("uninvestigated findings are always named, even past the display cap", () => {
		// The shared-services digest of 2026-09-03 reported "uninvestigated: 2"
		// while the two drift findings sat past the cap, so the operator had
		// to dig through the source journal to learn which ones they were.
		const notables = Array.from({ length: 12 }, (_, i) => notable({ resource: `i-${i}`, uninvestigated: i === 11 }));
		const text = formatDigest({ ...quietDigest, findingCounts: { drift: 12 }, notables });
		expect(text).toContain("uninvestigated: 1");
		const line = text.split("\n").find((l) => l.includes("i-11:"));
		expect(line).toContain("[uninvestigated]");
		expect(text).toContain("+2 more warn+ finding(s)");
	});

	test("uninvestigated findings lead the list, then severity orders the rest", () => {
		const text = formatDigest({
			...quietDigest,
			findingCounts: { cert: 1, drift: 2 },
			notables: [
				notable({ severity: "critical", family: "cert", resource: "crit-investigated" }),
				notable({ resource: "warn-investigated" }),
				notable({ resource: "warn-open", uninvestigated: true }),
			],
		});
		expect(text.indexOf("warn-open")).toBeLessThan(text.indexOf("crit-investigated"));
		expect(text.indexOf("crit-investigated")).toBeLessThan(text.indexOf("warn-investigated"));
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
			row({
				...finding,
				severity: "warn",
				resource: "warned",
				diagnosis: { probable_cause: "x", affected_resources: [], suggested_action: "y" },
			}),
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

describe("suppression review", () => {
	const ledger = [
		{
			pattern: "alarm:%-Utilization-Low-20:%",
			reason: "accepted dev rightsizing noise",
			created_at: "2026-09-01T09:34:00Z",
		},
		{ pattern: "logs:/aws/msk/brokers:%", reason: "msk rebalance chatter", created_at: "2026-09-01T09:35:00Z" },
	];
	const supRow = (suppressed_by: string, dedup_key: string) => ({
		payload: JSON.stringify({ family: "alarm", dedup_key, suppressed_by, reason: "r" }),
	});

	test("builder counts matches per ledger entry and caps distinct samples at 3", () => {
		const rows = [
			supRow("alarm:%-Utilization-Low-20:%", "alarm:kong:ALARM"),
			supRow("alarm:%-Utilization-Low-20:%", "alarm:kong:ALARM"),
			supRow("alarm:%-Utilization-Low-20:%", "alarm:a:ALARM"),
			supRow("alarm:%-Utilization-Low-20:%", "alarm:b:ALARM"),
			supRow("alarm:%-Utilization-Low-20:%", "alarm:c:ALARM"),
		];
		const entries = suppressionReviewFromJournal(ledger, rows);
		expect(entries).toHaveLength(2);
		expect(entries[0].matches).toBe(5);
		expect(entries[0].sampleKeys).toHaveLength(3);
		expect(entries[0].sampleKeys[0]).toBe("alarm:kong:ALARM");
		expect(entries[1].matches).toBe(0);
	});

	test("builder skips unparseable journal rows", () => {
		const entries = suppressionReviewFromJournal(ledger, [
			{ payload: "not json" },
			supRow("logs:/aws/msk/brokers:%", "logs:/aws/msk/brokers:x"),
		]);
		expect(entries[1].matches).toBe(1);
	});

	test("formatter renders header, entries, and flags zero-match entries", () => {
		const text = formatSuppressionReview({
			accountId: "120999474587",
			windowDays: 7,
			entries: [
				{ ...ledger[0], matches: 43, sampleKeys: ["alarm:kong:ALARM"] },
				{ ...ledger[1], matches: 0, sampleKeys: [] },
			],
		});
		expect(text.split("\n")[0]).toBe("[info] aws-120999474587 suppression review (last 7d)");
		expect(text).toContain("alarm:%-Utilization-Low-20:%");
		expect(text).toContain("accepted dev rightsizing noise");
		expect(text).toContain("matches last 7d: 43");
		expect(text).toContain("alarm:kong:ALARM");
		expect(text).toContain("no matches in 7d; candidate for unsuppress");
	});

	test("formatter renders an explicit nothing-masked line for an empty ledger", () => {
		const text = formatSuppressionReview({ accountId: "120999474587", windowDays: 7, entries: [] });
		expect(text).toContain("suppression ledger is empty");
		expect(text).toContain("nothing is being masked");
	});
});
