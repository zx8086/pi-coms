// tests/checks-certs.test.ts
import { describe, expect, test } from "bun:test";
import { ListCertificatesCommand } from "@aws-sdk/client-acm";
import { checkCerts } from "../scripts/monitor/checks/certs.ts";
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

describe("checkCerts", () => {
	test("inside 30 days is warn, inside 7 days is critical", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			fakeClient([
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
		const client = fakeClient([{ arn: "arn:cert/a", domain: "a.example.com", daysLeft: 20 }]);
		expect(await checkCerts(client, state, { now: NOW })).toHaveLength(1);
		expect(await checkCerts(client, state, { now: NOW + DAY })).toHaveLength(0);
	});

	test("crossing from warn into critical alerts again immediately", async () => {
		const state = new MonitorState(":memory:");
		await checkCerts(fakeClient([{ arn: "arn:cert/a", domain: "a.example.com", daysLeft: 8 }]), state, {
			now: NOW,
		});
		const out = await checkCerts(
			fakeClient([{ arn: "arn:cert/a", domain: "a.example.com", daysLeft: 6 }]),
			state,
			{ now: NOW + 2 * DAY },
		);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("critical");
	});

	test("healthy estate produces nothing", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCerts(
			fakeClient([{ arn: "arn:cert/c", domain: "c.example.com", daysLeft: 90 }]),
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
			fakeClient([
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
			fakeClient([
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
			fakeClient([
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
			fakeClient([
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
			fakeClient([
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
			fakeClient([
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
