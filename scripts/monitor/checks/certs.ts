// scripts/monitor/checks/certs.ts
import { DescribeCertificateCommand, ListCertificatesCommand } from "@aws-sdk/client-acm";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// ACM-managed certs renew ~60 days before expiry, so anything inside 30 days
// means renewal is failing -- a fully predictable outage.
const WARN_DAYS = 30;
const CRIT_DAYS = 7;
const REALERT_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

export type CheckCertsOpts = { now?: number; warnDays?: number; critDays?: number };

export async function checkCerts(
	client: AwsClient,
	state: MonitorState,
	opts: CheckCertsOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const warnDays = opts.warnDays ?? WARN_DAYS;
	const critDays = opts.critDays ?? CRIT_DAYS;
	const findings: Finding[] = [];
	const at = new Date(now).toISOString();

	const arns: string[] = [];
	let nextToken: string | undefined;
	do {
		const resp: any = await client.send(new ListCertificatesCommand({ NextToken: nextToken }));
		for (const c of resp.CertificateSummaryList ?? []) if (c.CertificateArn) arns.push(c.CertificateArn);
		nextToken = resp.NextToken;
	} while (nextToken);

	for (const arn of arns) {
		const resp: any = await client.send(new DescribeCertificateCommand({ CertificateArn: arn }));
		const cert = resp.Certificate;
		if (!cert?.NotAfter) continue;
		const daysLeft = Math.floor((new Date(cert.NotAfter).getTime() - now) / DAY_MS);
		if (daysLeft > warnDays) continue;
		const severity = daysLeft <= critDays ? "critical" : "warn";
		const key = `cert:${arn}:${severity}`;
		if (!state.shouldAlert(key, REALERT_MS)) continue;
		state.markAlerted(key, "cert");
		findings.push({
			family: "cert",
			severity,
			resource: cert.DomainName ?? arn,
			summary: `Certificate ${cert.DomainName ?? arn} expires in ${daysLeft} day(s)`,
			dedup_key: key,
			evidence: {
				arn,
				notAfter: new Date(cert.NotAfter).toISOString(),
				daysLeft,
				renewalEligibility: cert.RenewalEligibility ?? null,
				inUseBy: cert.InUseBy ?? [],
			},
			at,
		});
	}
	return findings;
}
