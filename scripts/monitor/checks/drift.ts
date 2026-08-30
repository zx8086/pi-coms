// scripts/monitor/checks/drift.ts
import { DescribeInstanceStatusCommand, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

const BAD_STATES = new Set(["stopped", "stopping", "terminated", "shutting-down"]);
const OK_STATUS = new Set(["ok", "not-applicable", "initializing"]);

export async function checkDrift(client: AwsClient, state: MonitorState): Promise<Finding[]> {
	const findings: Finding[] = [];
	const now = new Date().toISOString();

	const di = await client.send(new DescribeInstancesCommand({}));
	const current: Record<string, string> = {};
	for (const r of di.Reservations ?? []) {
		for (const i of r.Instances ?? []) {
			if (i.InstanceId) current[i.InstanceId] = i.State?.Name ?? "unknown";
		}
	}

	// State-change findings are edge-triggered by the snapshot diff, so they
	// need no fingerprints; the first run only establishes the baseline.
	const prev = state.getSnapshot("instances");
	if (prev !== null) {
		for (const [id, st] of Object.entries(current)) {
			const was = prev[id];
			if (was === undefined) {
				findings.push({
					family: "drift",
					severity: "info",
					resource: id,
					summary: `New instance ${id} (${st})`,
					dedup_key: `drift:${id}:new`,
					evidence: { state: st },
					at: now,
				});
			} else if (was !== st) {
				findings.push({
					family: "drift",
					severity: BAD_STATES.has(st) ? "warn" : "info",
					resource: id,
					summary: `Instance ${id} changed state ${was} -> ${st}`,
					dedup_key: `drift:${id}:state:${st}`,
					evidence: { from: was, to: st },
					at: now,
				});
			}
		}
		for (const id of Object.keys(prev)) {
			if (!(id in current)) {
				findings.push({
					family: "drift",
					severity: "warn",
					resource: id,
					summary: `Instance ${id} disappeared (was ${prev[id]})`,
					dedup_key: `drift:${id}:gone`,
					evidence: { was: prev[id] },
					at: now,
				});
			}
		}
	}
	state.setSnapshot("instances", current);

	const ds = await client.send(new DescribeInstanceStatusCommand({ IncludeAllInstances: false }));
	const failedNow = new Set<string>();
	for (const s of ds.InstanceStatuses ?? []) {
		const id = s.InstanceId ?? "unknown";
		const sys = s.SystemStatus?.Status ?? "ok";
		const inst = s.InstanceStatus?.Status ?? "ok";
		const failed = !OK_STATUS.has(sys) || !OK_STATUS.has(inst);
		if (!failed) continue;
		failedNow.add(id);
		const key = `drift:${id}:statuscheck`;
		if (!state.shouldAlert(key)) continue;
		state.markAlerted(key, "drift");
		findings.push({
			family: "drift",
			severity: "warn",
			resource: id,
			summary: `Instance ${id} failing status check (system=${sys} instance=${inst})`,
			dedup_key: key,
			evidence: { system: sys, instance: inst },
			at: now,
		});
	}
	// Recovery: clear fingerprints for instances no longer failing.
	for (const key of state.alertKeys("drift:")) {
		const m = key.match(/^drift:(.+):statuscheck$/);
		if (m && !failedNow.has(m[1])) state.clearAlerts(key);
	}
	return findings;
}
