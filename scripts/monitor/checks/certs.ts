// scripts/monitor/checks/certs.ts
import {
	type CertificateDetail,
	DescribeCertificateCommand,
	type DescribeCertificateCommandOutput,
	ListCertificatesCommand,
	type ListCertificatesCommandOutput,
} from "@aws-sdk/client-acm";
import { errorMessage } from "../errors.ts";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// ACM-managed certs renew ~60 days before expiry, so anything inside 30 days
// means renewal is failing -- a fully predictable outage.
const WARN_DAYS = 30;
const CRIT_DAYS = 7;
const REALERT_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

// Only certificates with an expiry take part in the scan.
type DatedCert = CertificateDetail & { NotAfter: Date };
function hasNotAfter(c: CertificateDetail | undefined): c is DatedCert {
	return c?.NotAfter != null;
}

export type CheckCertsOpts = { now?: number; warnDays?: number; critDays?: number };
export type RegionalAcm = { region: string; client: AwsClient };

// The host region plus us-east-1 by default: CloudFront certificates must
// live in us-east-1, so an expiring one is invisible to a host-region scan.
export function certRegions(hostRegion: string | undefined, envList: string | undefined): string[] {
	const list = envList
		? envList.split(",").map((r) => r.trim()).filter((r) => r.length > 0)
		: [hostRegion, "us-east-1"].filter((r): r is string => typeof r === "string" && r.length > 0);
	return [...new Set(list)];
}

export async function checkCerts(
	clients: RegionalAcm[],
	state: MonitorState,
	opts: CheckCertsOpts = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const warnDays = opts.warnDays ?? WARN_DAYS;
	const critDays = opts.critDays ?? CRIT_DAYS;
	const findings: Finding[] = [];
	const at = new Date(now).toISOString();

	// Describe everything first: whether an expiring cert matters depends on
	// what else covers its domain (a rotated-out cert is noise, not risk).
	const certs: {
		arn: string;
		region: string;
		cert: DatedCert;
		daysLeft: number;
		names: string[];
	}[] = [];
	for (const { region, client } of clients) {
		try {
			const arns: string[] = [];
			let nextToken: string | undefined;
			do {
				const resp = (await client.send(
					new ListCertificatesCommand({ NextToken: nextToken }),
				)) as ListCertificatesCommandOutput;
				for (const c of resp.CertificateSummaryList ?? []) if (c.CertificateArn) arns.push(c.CertificateArn);
				nextToken = resp.NextToken;
			} while (nextToken);
			for (const arn of arns) {
				const resp = (await client.send(
					new DescribeCertificateCommand({ CertificateArn: arn }),
				)) as DescribeCertificateCommandOutput;
				const cert = resp.Certificate;
				if (!hasNotAfter(cert)) continue;
				const daysLeft = Math.floor((new Date(cert.NotAfter).getTime() - now) / DAY_MS);
				const names = [cert.DomainName, ...(cert.SubjectAlternativeNames ?? [])].filter(
					(n: unknown): n is string => typeof n === "string" && n.length > 0,
				);
				certs.push({ arn, region, cert, daysLeft, names });
			}
		} catch (e) {
			// One unreachable region must not kill the scan: report it once as an
			// info scoping fact and keep scanning the other regions.
			const scopeKey = `cert:scope:${region}:`;
			if (state.shouldAlert(scopeKey)) {
				state.markAlerted(scopeKey, "cert");
				findings.push({
					family: "cert",
					severity: "info",
					resource: region,
					summary: `ACM in ${region} is unreadable (not inspected): ${errorMessage(e)}`,
					dedup_key: scopeKey,
					evidence: { region, error: errorMessage(e) },
					at,
				});
			}
		}
	}

	for (const { arn, region, cert, daysLeft } of certs) {
		if (daysLeft > warnDays) continue;
		const domain: string = cert.DomainName ?? arn;
		// Same-region only: a valid cert elsewhere cannot serve resources bound
		// to this region (CloudFront needs us-east-1), so cross-region
		// supersession would mask a real gap.
		const successor = certs.find(
			(s) =>
				s.arn !== arn && s.region === region && s.daysLeft > warnDays && s.names.some((n) => covers(n, domain)),
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
			summary: `Certificate ${domain} (${region}) expires in ${daysLeft} day(s)${supersededNote}`,
			dedup_key: key,
			evidence: {
				arn,
				region,
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
