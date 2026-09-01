// tests/checks-certs.test.ts
import { describe, expect, test } from "bun:test";
import { ListCertificatesCommand } from "@aws-sdk/client-acm";
import { checkCerts } from "../scripts/monitor/checks/certs.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const DAY = 86_400_000;

function fakeClient(certs: { arn: string; domain: string; daysLeft: number }[]) {
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
