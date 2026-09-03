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

	// Describe everything first: whether an expiring cert matters depends on
	// what else covers its domain (a rotated-out cert is noise, not risk).
	const certs: {
		arn: string;
		cert: any;
		daysLeft: number;
		names: string[];
	}[] = [];
	for (const arn of arns) {
		const resp: any = await client.send(new DescribeCertificateCommand({ CertificateArn: arn }));
		const cert = resp.Certificate;
		if (!cert?.NotAfter) continue;
		const daysLeft = Math.floor((new Date(cert.NotAfter).getTime() - now) / DAY_MS);
		const names = [cert.DomainName, ...(cert.SubjectAlternativeNames ?? [])].filter(
			(n: unknown): n is string => typeof n === "string" && n.length > 0,
		);
		certs.push({ arn, cert, daysLeft, names });
	}

	for (const { arn, cert, daysLeft } of certs) {
		if (daysLeft > warnDays) continue;
		const domain: string = cert.DomainName ?? arn;
		const successor = certs.find(
			(s) => s.arn !== arn && s.daysLeft > warnDays && s.names.some((n) => covers(n, domain)),
		);
		const severity = successor ? "info" : daysLeft <= critDays ? "critical" : "warn";
		const key = `cert:${arn}:${severity}`;
		if (!state.shouldAlert(key, REALERT_MS)) continue;
		state.markAlerted(key, "cert");
		const supersededNote = successor
			? `; superseded by a valid certificate for ${successor.cert.DomainName ?? successor.arn} (expires ${new Date(successor.cert.NotAfter).toISOString()})`
			: "";
		findings.push({
			family: "cert",
			severity,
			resource: domain,
			summary: `Certificate ${domain} expires in ${daysLeft} day(s)${supersededNote}`,
			dedup_key: key,
			evidence: {
				arn,
				notAfter: new Date(cert.NotAfter).toISOString(),
				daysLeft,
				renewalEligibility: cert.RenewalEligibility ?? null,
				inUseBy: cert.InUseBy ?? [],
				...(successor
					? {
							supersededBy: {
								arn: successor.arn,
								domain: successor.cert.DomainName ?? null,
								notAfter: new Date(successor.cert.NotAfter).toISOString(),
							},
						}
					: {}),
			},
			at,
		});
	}
	return findings;
}

// Exact match, or single-label wildcard: *.example.com covers a.example.com
// but not example.com or a.b.example.com.
function covers(name: string, domain: string): boolean {
	if (name === domain) return true;
	if (!name.startsWith("*.")) return false;
	const suffix = name.slice(2);
	return domain.endsWith(`.${suffix}`) && !domain.slice(0, -suffix.length - 1).includes(".");
}
