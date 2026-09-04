// scripts/monitor/checks/resource-drift.ts
import {
	DescribeRouteTablesCommand,
	type DescribeRouteTablesCommandOutput,
	DescribeSecurityGroupsCommand,
	type DescribeSecurityGroupsCommandOutput,
	type IpPermission,
	type Route,
} from "@aws-sdk/client-ec2";

// Re-exported so tests need no direct dependency on the SDK (it lives in scripts/package.json).
export type { IpPermission };

import { ListFunctionsCommand, type ListFunctionsCommandOutput } from "@aws-sdk/client-lambda";
import { DescribeDBInstancesCommand, type DescribeDBInstancesCommandOutput } from "@aws-sdk/client-rds";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

// Snapshot-diff drift for non-EC2-instance resources (SIO-1597). Same
// edge-triggered pattern as checks/drift.ts: the first run establishes a
// baseline silently, later runs report only differences and then store the
// new state as the next baseline, so no fingerprints are needed for change
// findings. A failing sub-scan degrades to one info finding (fingerprinted
// so it does not repeat every cycle) and the remaining scans still run.

type Differ = {
	snapshot: string;
	added?: (id: string) => Finding | null;
	removed?: (id: string) => Finding | null;
	changed: (id: string, was: string, now: string) => Finding;
};

function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v && typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>)
			.filter(([, val]) => val !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(v);
}

function diffSnapshot(state: MonitorState, current: Record<string, string>, d: Differ): Finding[] {
	const findings: Finding[] = [];
	const prev = state.getSnapshot(d.snapshot);
	if (prev !== null) {
		for (const [id, now] of Object.entries(current)) {
			const was = prev[id];
			if (was === undefined) {
				const f = d.added?.(id);
				if (f) findings.push(f);
			} else if (was !== now) {
				findings.push(d.changed(id, was, now));
			}
		}
		for (const id of Object.keys(prev)) {
			if (!(id in current)) {
				const f = d.removed?.(id);
				if (f) findings.push(f);
			}
		}
	}
	state.setSnapshot(d.snapshot, current);
	return findings;
}

function info(resource: string, summary: string, dedup_key: string, evidence: unknown, at: string): Finding {
	return { family: "drift", severity: "info", resource, summary, dedup_key, evidence, at };
}

function ruleKey(r: IpPermission): string {
	const sources = [
		...(r.IpRanges ?? []).map((x) => x.CidrIp),
		...(r.Ipv6Ranges ?? []).map((x) => x.CidrIpv6),
		...(r.PrefixListIds ?? []).map((x) => x.PrefixListId),
		...(r.UserIdGroupPairs ?? []).map((x) => x.GroupId),
	].sort();
	return `${r.IpProtocol ?? "-"}:${r.FromPort ?? "-"}:${r.ToPort ?? "-"}:${sources.join("|")}`;
}

function routeTarget(r: Route): string {
	return (
		r.GatewayId ??
		r.NatGatewayId ??
		r.TransitGatewayId ??
		r.VpcPeeringConnectionId ??
		r.NetworkInterfaceId ??
		r.InstanceId ??
		r.LocalGatewayId ??
		r.CarrierGatewayId ??
		"unknown"
	);
}

async function scanSecurityGroups(ec2: AwsClient): Promise<Record<string, string>> {
	const current: Record<string, string> = {};
	let token: string | undefined;
	do {
		const resp = (await ec2.send(
			new DescribeSecurityGroupsCommand({ NextToken: token }),
		)) as DescribeSecurityGroupsCommandOutput;
		for (const g of resp.SecurityGroups ?? []) {
			if (!g.GroupId) continue;
			current[g.GroupId] = canonical({
				ingress: (g.IpPermissions ?? []).map(ruleKey).sort(),
				egress: (g.IpPermissionsEgress ?? []).map(ruleKey).sort(),
			});
		}
		token = resp.NextToken;
	} while (token);
	return current;
}

async function scanRouteTables(ec2: AwsClient): Promise<Record<string, string>> {
	const current: Record<string, string> = {};
	let token: string | undefined;
	do {
		const resp = (await ec2.send(
			new DescribeRouteTablesCommand({ NextToken: token }),
		)) as DescribeRouteTablesCommandOutput;
		for (const t of resp.RouteTables ?? []) {
			if (!t.RouteTableId) continue;
			const routes = (t.Routes ?? [])
				.map(
					(r) =>
						`${r.DestinationCidrBlock ?? r.DestinationPrefixListId ?? r.DestinationIpv6CidrBlock ?? "?"}->${routeTarget(r)}:${r.State ?? "?"}`,
				)
				.sort();
			current[t.RouteTableId] = canonical(routes);
		}
		token = resp.NextToken;
	} while (token);
	return current;
}

async function scanRdsInstances(rds: AwsClient): Promise<Record<string, string>> {
	const current: Record<string, string> = {};
	let marker: string | undefined;
	do {
		const resp = (await rds.send(
			new DescribeDBInstancesCommand({ Marker: marker }),
		)) as DescribeDBInstancesCommandOutput;
		for (const d of resp.DBInstances ?? []) {
			if (!d.DBInstanceIdentifier) continue;
			current[d.DBInstanceIdentifier] = canonical({
				status: d.DBInstanceStatus ?? "unknown",
				class: d.DBInstanceClass ?? "unknown",
				engineVersion: d.EngineVersion ?? "unknown",
				multiAz: d.MultiAZ === true,
				publiclyAccessible: d.PubliclyAccessible === true,
			});
		}
		marker = resp.Marker;
	} while (marker);
	return current;
}

async function scanLambdaFunctions(lambda: AwsClient): Promise<Record<string, string>> {
	const current: Record<string, string> = {};
	let marker: string | undefined;
	do {
		const resp = (await lambda.send(new ListFunctionsCommand({ Marker: marker }))) as ListFunctionsCommandOutput;
		for (const f of resp.Functions ?? []) {
			if (!f.FunctionName) continue;
			current[f.FunctionName] = canonical({
				runtime: f.Runtime ?? "unknown",
				memory: f.MemorySize ?? 0,
				timeout: f.Timeout ?? 0,
				role: f.Role ?? "unknown",
			});
		}
		marker = resp.NextMarker;
	} while (marker);
	return current;
}

function parseRds(v: string): { status: string; publiclyAccessible: boolean } {
	try {
		const p = JSON.parse(v);
		return { status: String(p.status), publiclyAccessible: p.publiclyAccessible === true };
	} catch {
		return { status: "unknown", publiclyAccessible: false };
	}
}

function parseLambdaRole(v: string): string {
	try {
		return String(JSON.parse(v).role);
	} catch {
		return "unknown";
	}
}

export async function checkResourceDrift(
	ec2: AwsClient,
	rds: AwsClient,
	lambda: AwsClient,
	state: MonitorState,
): Promise<Finding[]> {
	const findings: Finding[] = [];
	const at = new Date().toISOString();

	const subs: { name: string; run: () => Promise<Finding[]> }[] = [
		{
			name: "security-groups",
			run: async () =>
				diffSnapshot(state, await scanSecurityGroups(ec2), {
					snapshot: "security-groups",
					added: (id) => info(id, `New security group ${id}`, `drift:${id}:new`, {}, at),
					removed: (id) => info(id, `Security group ${id} deleted`, `drift:${id}:gone`, {}, at),
					changed: (id, was, now) => ({
						family: "drift",
						severity: "warn",
						resource: id,
						summary: `Security group ${id} rules changed`,
						dedup_key: `drift:${id}:rules`,
						evidence: { from: was, to: now },
						at,
					}),
				}),
		},
		{
			name: "route-tables",
			run: async () =>
				diffSnapshot(state, await scanRouteTables(ec2), {
					snapshot: "route-tables",
					added: (id) => info(id, `New route table ${id}`, `drift:${id}:new`, {}, at),
					removed: (id) => info(id, `Route table ${id} deleted`, `drift:${id}:gone`, {}, at),
					changed: (id, was, now) => ({
						family: "drift",
						severity: "warn",
						resource: id,
						summary: `Route table ${id} routes changed`,
						dedup_key: `drift:${id}:routes`,
						evidence: { from: was, to: now },
						at,
					}),
				}),
		},
		{
			name: "rds-instances",
			run: async () =>
				diffSnapshot(state, await scanRdsInstances(rds), {
					snapshot: "rds-instances",
					added: (id) => info(id, `New RDS instance ${id}`, `drift:${id}:new`, {}, at),
					removed: (id) => info(id, `RDS instance ${id} deleted`, `drift:${id}:gone`, {}, at),
					changed: (id, was, now) => {
						const w = parseRds(was);
						const n = parseRds(now);
						const severity =
							!w.publiclyAccessible && n.publiclyAccessible ? "critical" : w.status !== n.status ? "warn" : "info";
						return {
							family: "drift",
							severity,
							resource: id,
							summary:
								severity === "critical"
									? `RDS instance ${id} became publicly accessible`
									: `RDS instance ${id} configuration changed`,
							dedup_key: severity === "critical" ? `drift:${id}:public` : `drift:${id}:config`,
							evidence: { from: was, to: now },
							at,
						};
					},
				}),
		},
		{
			name: "lambda-functions",
			run: async () =>
				diffSnapshot(state, await scanLambdaFunctions(lambda), {
					snapshot: "lambda-functions",
					added: (id) => info(id, `New Lambda function ${id}`, `drift:${id}:new`, {}, at),
					removed: (id) => info(id, `Lambda function ${id} deleted`, `drift:${id}:gone`, {}, at),
					changed: (id, was, now) => {
						const roleChanged = parseLambdaRole(was) !== parseLambdaRole(now);
						return {
							family: "drift",
							severity: roleChanged ? "warn" : "info",
							resource: id,
							summary: roleChanged
								? `Lambda function ${id} execution role changed`
								: `Lambda function ${id} configuration changed`,
							dedup_key: `drift:${id}:config`,
							evidence: { from: was, to: now },
							at,
						};
					},
				}),
		},
	];

	for (const sub of subs) {
		const scanKey = `drift:scan:${sub.name}`;
		try {
			findings.push(...(await sub.run()));
			state.clearAlerts(scanKey);
		} catch (err) {
			// One info scoping finding, once, and the remaining scans still run
			// (same posture as the logs check's denied-log-group handling).
			if (state.shouldAlert(scanKey)) {
				state.markAlerted(scanKey, "drift");
				findings.push(
					info(
						sub.name,
						`Resource drift: ${sub.name} scan failed: ${err instanceof Error ? err.message : String(err)}`,
						scanKey,
						{},
						at,
					),
				);
			}
		}
	}
	return findings;
}
