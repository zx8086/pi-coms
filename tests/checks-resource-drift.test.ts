// tests/checks-resource-drift.test.ts
import { describe, expect, test } from "bun:test";
import { checkResourceDrift } from "../scripts/monitor/checks/resource-drift.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

type Sg = { id: string; ingress?: any[]; egress?: any[] };
type Rtb = { id: string; routes?: { dest: string; target: string }[] };
type Db = {
	id: string;
	status?: string;
	klass?: string;
	engineVersion?: string;
	multiAz?: boolean;
	publiclyAccessible?: boolean;
};
type Fn = { name: string; runtime?: string; memory?: number; timeout?: number; role?: string };

function ec2Client(sgs: Sg[], rtbs: Rtb[], failSgs = false) {
	return {
		async send(cmd: any) {
			if (cmd.constructor.name === "DescribeSecurityGroupsCommand") {
				if (failSgs) throw new Error("AccessDenied: DescribeSecurityGroups");
				return {
					SecurityGroups: sgs.map((g) => ({
						GroupId: g.id,
						IpPermissions: g.ingress ?? [],
						IpPermissionsEgress: g.egress ?? [],
					})),
				};
			}
			if (cmd.constructor.name === "DescribeRouteTablesCommand") {
				return {
					RouteTables: rtbs.map((t) => ({
						RouteTableId: t.id,
						Routes: (t.routes ?? []).map((r) => ({
							DestinationCidrBlock: r.dest,
							GatewayId: r.target,
							State: "active",
						})),
					})),
				};
			}
			throw new Error(`unexpected ${cmd.constructor.name}`);
		},
	};
}

function rdsClient(dbs: Db[]) {
	return {
		async send(cmd: any) {
			if (cmd.constructor.name !== "DescribeDBInstancesCommand") {
				throw new Error(`unexpected ${cmd.constructor.name}`);
			}
			return {
				DBInstances: dbs.map((d) => ({
					DBInstanceIdentifier: d.id,
					DBInstanceStatus: d.status ?? "available",
					DBInstanceClass: d.klass ?? "db.t4g.micro",
					EngineVersion: d.engineVersion ?? "16.4",
					MultiAZ: d.multiAz ?? false,
					PubliclyAccessible: d.publiclyAccessible ?? false,
				})),
			};
		},
	};
}

function lambdaClient(fns: Fn[]) {
	return {
		async send(cmd: any) {
			if (cmd.constructor.name !== "ListFunctionsCommand") {
				throw new Error(`unexpected ${cmd.constructor.name}`);
			}
			return {
				Functions: fns.map((f) => ({
					FunctionName: f.name,
					Runtime: f.runtime ?? "nodejs22.x",
					MemorySize: f.memory ?? 128,
					Timeout: f.timeout ?? 3,
					Role: f.role ?? "arn:aws:iam::1:role/app",
				})),
			};
		},
	};
}

const SG_RULE = { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "10.0.0.0/8" }] };
const SG_RULE_WIDE = { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] };

function clients(over: Partial<{ sgs: Sg[]; rtbs: Rtb[]; dbs: Db[]; fns: Fn[]; failSgs: boolean }> = {}) {
	return {
		ec2: ec2Client(over.sgs ?? [], over.rtbs ?? [], over.failSgs ?? false),
		rds: rdsClient(over.dbs ?? []),
		lambda: lambdaClient(over.fns ?? []),
	};
}

async function run(state: MonitorState, over: Parameters<typeof clients>[0] = {}) {
	const c = clients(over);
	return checkResourceDrift(c.ec2, c.rds, c.lambda, state);
}

describe("checkResourceDrift", () => {
	test("first run establishes all baselines silently", async () => {
		const state = new MonitorState(":memory:");
		const out = await run(state, {
			sgs: [{ id: "sg-1", ingress: [SG_RULE] }],
			rtbs: [{ id: "rtb-1", routes: [{ dest: "0.0.0.0/0", target: "nat-1" }] }],
			dbs: [{ id: "db-1" }],
			fns: [{ name: "fn-1" }],
		});
		expect(out).toHaveLength(0);
		expect(state.getSnapshot("security-groups")).not.toBeNull();
		expect(state.getSnapshot("route-tables")).not.toBeNull();
		expect(state.getSnapshot("rds-instances")).not.toBeNull();
		expect(state.getSnapshot("lambda-functions")).not.toBeNull();
	});

	test("security group rule change is warn, once; new and removed groups are info", async () => {
		const state = new MonitorState(":memory:");
		await run(state, { sgs: [{ id: "sg-1", ingress: [SG_RULE] }, { id: "sg-2" }] });
		const out = await run(state, {
			sgs: [{ id: "sg-1", ingress: [SG_RULE_WIDE] }, { id: "sg-3" }],
		});
		const bySev = out.map((f) => `${f.resource}:${f.severity}`).sort();
		expect(bySev).toEqual(["sg-1:warn", "sg-2:info", "sg-3:info"]);
		expect(await run(state, { sgs: [{ id: "sg-1", ingress: [SG_RULE_WIDE] }, { id: "sg-3" }] })).toHaveLength(0);
	});

	test("egress rule change is also a warn", async () => {
		const state = new MonitorState(":memory:");
		await run(state, { sgs: [{ id: "sg-1", egress: [SG_RULE] }] });
		const out = await run(state, { sgs: [{ id: "sg-1", egress: [SG_RULE, SG_RULE_WIDE] }] });
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
	});

	test("route change is warn", async () => {
		const state = new MonitorState(":memory:");
		await run(state, { rtbs: [{ id: "rtb-1", routes: [{ dest: "0.0.0.0/0", target: "nat-1" }] }] });
		const out = await run(state, {
			rtbs: [{ id: "rtb-1", routes: [{ dest: "0.0.0.0/0", target: "igw-1" }] }],
		});
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		expect(out[0].summary).toContain("rtb-1");
	});

	test("rds flip to publicly accessible is critical; status change is warn; class change is info", async () => {
		const state = new MonitorState(":memory:");
		await run(state, { dbs: [{ id: "db-1" }, { id: "db-2" }, { id: "db-3" }] });
		const out = await run(state, {
			dbs: [
				{ id: "db-1", publiclyAccessible: true },
				{ id: "db-2", status: "stopped" },
				{ id: "db-3", klass: "db.r6g.large" },
			],
		});
		const sev = Object.fromEntries(out.map((f) => [f.resource, f.severity]));
		expect(sev["db-1"]).toBe("critical");
		expect(sev["db-2"]).toBe("warn");
		expect(sev["db-3"]).toBe("info");
	});

	test("lambda role change is warn; memory change is info", async () => {
		const state = new MonitorState(":memory:");
		await run(state, { fns: [{ name: "fn-1" }, { name: "fn-2" }] });
		const out = await run(state, {
			fns: [
				{ name: "fn-1", role: "arn:aws:iam::1:role/other" },
				{ name: "fn-2", memory: 512 },
			],
		});
		const sev = Object.fromEntries(out.map((f) => [f.resource, f.severity]));
		expect(sev["fn-1"]).toBe("warn");
		expect(sev["fn-2"]).toBe("info");
	});

	test("a failing sub-scan becomes one info finding and the others still run", async () => {
		const state = new MonitorState(":memory:");
		await run(state, { dbs: [{ id: "db-1" }] });
		const out = await run(state, { failSgs: true, dbs: [{ id: "db-1", status: "stopped" }] });
		const scanFindings = out.filter((f) => f.dedup_key === "drift:scan:security-groups");
		expect(scanFindings).toHaveLength(1);
		expect(scanFindings[0].severity).toBe("info");
		expect(out.some((f) => f.resource === "db-1" && f.severity === "warn")).toBe(true);
		const again = await run(state, { failSgs: true, dbs: [{ id: "db-1", status: "stopped" }] });
		expect(again.filter((f) => f.dedup_key === "drift:scan:security-groups")).toHaveLength(0);
	});
});
