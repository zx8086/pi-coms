// tests/checks-certs.test.ts
import { describe, expect, test } from "bun:test";
import { ListCertificatesCommand } from "@aws-sdk/client-acm";
import { certRegions, checkCerts } from "../scripts/monitor/checks/certs.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const DAY = 86_400_000;

function fakeClient(certs: { arn: string; domain: string; daysLeft: number; sans?: string[] }[]) {
	return {
		send: async (cmd: any) => {
			if (cmd instanceof ListCertificatesCommand) {
				return { CertificateSummaryList: certs.map((c) => ({ CertificateArn: c.arn })) };
			}
			const c = certs.find((x) => x.arn === cmd.input.CertificateArn);
			return {
				Certificate: {
					CertificateArn: c?.arn,
					DomainName: c?.domain,
					SubjectAlternativeNames: c?.sans,
					NotAfter: new Date(NOW + (c?.daysLeft ?? 0) * DAY),
				},
			};
		},
	};
}

const eu = (certs: Parameters<typeof fakeClient>[0]) => [
	{ region: "eu-central-1", client: fakeClient(certs) },
];

describe("checkCerts", () => {
	test("inside 30 days is warn, inside 7 days is critical", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			eu([
				{ arn: "arn:cert/a", domain: "a.example.com", daysLeft: 20 },
				{ arn: "arn:cert/b", domain: "b.example.com", daysLeft: 3 },
				{ arn: "arn:cert/c", domain: "c.example.com", daysLeft: 200 },
			]),
			state,
			{ now: NOW },
		);
		expect(out).toHaveLength(2);
		const byDomain = new Map(out.map((f) => [f.resource, f.severity]));
		expect(byDomain.get("a.example.com")).toBe("warn");
		expect(byDomain.get("b.example.com")).toBe("critical");
	});

	test("an already-alerted cert stays quiet inside the re-alert window", async () => {
		const state = new MonitorState(":memory:");
		const clients = eu([{ arn: "arn:cert/a", domain: "a.example.com", daysLeft: 20 }]);
		expect(await checkCerts(clients, state, { now: NOW })).toHaveLength(1);
		expect(await checkCerts(clients, state, { now: NOW + DAY })).toHaveLength(0);
	});

	test("crossing from warn into critical alerts again immediately", async () => {
		const state = new MonitorState(":memory:");
		await checkCerts(eu([{ arn: "arn:cert/a", domain: "a.example.com", daysLeft: 8 }]), state, {
			now: NOW,
		});
		const out = await checkCerts(
			eu([{ arn: "arn:cert/a", domain: "a.example.com", daysLeft: 6 }]),
			state,
			{ now: NOW + 2 * DAY },
		);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("critical");
	});

	test("healthy estate produces nothing", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			eu([{ arn: "arn:cert/c", domain: "c.example.com", daysLeft: 90 }]),
			state,
			{ now: NOW },
		);
		expect(out).toHaveLength(0);
	});
});

describe("checkCerts supersession", () => {
	test("an expired cert with a valid same-domain successor downgrades to info", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			eu([
				{ arn: "arn:cert/old", domain: "prana-dev.example.com", daysLeft: -979 },
				{ arn: "arn:cert/new", domain: "prana-dev.example.com", daysLeft: 300 },
			]),
			state,
			{ now: NOW },
		);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("info");
		expect(out[0].summary).toContain("superseded");
		expect((out[0].evidence as any).supersededBy.arn).toBe("arn:cert/new");
	});

	test("stays critical when the only other same-domain cert is also expired", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			eu([
				{ arn: "arn:cert/old", domain: "a.example.com", daysLeft: -100 },
				{ arn: "arn:cert/older", domain: "a.example.com", daysLeft: -700 },
			]),
			state,
			{ now: NOW },
		);
		expect(out).toHaveLength(2);
		for (const f of out) expect(f.severity).toBe("critical");
	});

	test("a valid cert for a different domain is not a successor", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			eu([
				{ arn: "arn:cert/old", domain: "a.example.com", daysLeft: -10 },
				{ arn: "arn:cert/other", domain: "b.example.com", daysLeft: 300 },
			]),
			state,
			{ now: NOW },
		);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("critical");
	});

	test("a wildcard successor covers a single-label subdomain", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			eu([
				{ arn: "arn:cert/old", domain: "a.example.com", daysLeft: -10 },
				{ arn: "arn:cert/wild", domain: "*.example.com", daysLeft: 300 },
			]),
			state,
			{ now: NOW },
		);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("info");
		expect((out[0].evidence as any).supersededBy.arn).toBe("arn:cert/wild");
	});

	test("SAN coverage counts as supersession", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			eu([
				{ arn: "arn:cert/old", domain: "a.example.com", daysLeft: -10 },
				{ arn: "arn:cert/san", domain: "main.example.com", daysLeft: 300, sans: ["a.example.com"] },
			]),
			state,
			{ now: NOW },
		);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("info");
	});

	test("a successor inside the warn window does not supersede", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			eu([
				{ arn: "arn:cert/old", domain: "a.example.com", daysLeft: -10 },
				{ arn: "arn:cert/soon", domain: "a.example.com", daysLeft: 20 },
			]),
			state,
			{ now: NOW },
		);
		// both alert: the expired one stays critical, the 20-day one warns
		const bySev = new Map(out.map((f) => [f.dedup_key, f.severity]));
		expect(bySev.get("cert:arn:cert/old:critical")).toBe("critical");
		expect(bySev.get("cert:arn:cert/soon:warn")).toBe("warn");
	});
});

describe("checkCerts multi-region", () => {
	test("findings come from every scanned region and carry the region", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			[
				{ region: "eu-central-1", client: fakeClient([{ arn: "arn:eu/a", domain: "a.example.com", daysLeft: -10 }]) },
				{ region: "us-east-1", client: fakeClient([{ arn: "arn:us/b", domain: "b.example.com", daysLeft: -20 }]) },
			],
			state,
			{ now: NOW },
		);
		expect(out).toHaveLength(2);
		const byArn = new Map(out.map((f) => [(f.evidence as any).arn, f]));
		expect((byArn.get("arn:eu/a")?.evidence as any).region).toBe("eu-central-1");
		expect((byArn.get("arn:us/b")?.evidence as any).region).toBe("us-east-1");
		expect(byArn.get("arn:us/b")?.summary).toContain("us-east-1");
	});

	test("a throwing region yields one info scoping finding and the other region still scans", async () => {
		const state = new MonitorState(":memory:");
		const broken = { send: async () => { throw new Error("AccessDenied"); } };
		const run = () =>
			checkCerts(
				[
					{ region: "us-east-1", client: broken },
					{ region: "eu-central-1", client: fakeClient([{ arn: "arn:eu/a", domain: "a.example.com", daysLeft: -10 }]) },
				],
				state,
				{ now: NOW },
			);
		const out = await run();
		expect(out).toHaveLength(2);
		const scope = out.find((f) => f.severity === "info");
		expect(scope?.summary).toContain("us-east-1");
		expect(scope?.summary).toContain("not inspected");
		expect(out.find((f) => (f.evidence as any).arn === "arn:eu/a")?.severity).toBe("critical");
		// scoping finding reports once, not per run
		expect((await run()).filter((f) => f.severity === "info")).toHaveLength(0);
	});

	test("successor matching stays within a region", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			[
				{ region: "eu-central-1", client: fakeClient([{ arn: "arn:eu/old", domain: "a.example.com", daysLeft: -10 }]) },
				{ region: "us-east-1", client: fakeClient([{ arn: "arn:us/new", domain: "a.example.com", daysLeft: 300 }]) },
			],
			state,
			{ now: NOW },
		);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("critical");
	});
});

describe("certRegions", () => {
	test("defaults to host region plus us-east-1", () => {
		expect(certRegions("eu-central-1", undefined)).toEqual(["eu-central-1", "us-east-1"]);
	});

	test("deduplicates when the host region is us-east-1", () => {
		expect(certRegions("us-east-1", undefined)).toEqual(["us-east-1"]);
	});

	test("env list overrides the default, trimmed and deduplicated", () => {
		expect(certRegions("eu-central-1", " eu-west-1, us-east-1 ,eu-west-1")).toEqual([
			"eu-west-1",
			"us-east-1",
		]);
	});

	test("an unset host region still yields us-east-1", () => {
		expect(certRegions(undefined, undefined)).toEqual(["us-east-1"]);
	});
});
