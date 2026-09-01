// scripts/coms-net-monitor.ts
//
// Per-host AWS account monitor. Deterministic scheduled checks (zero tokens
// when quiet); findings warn+ are investigated by the account's Pi agent over
// coms-net; reports mail to the operator via the hub mailbox with a long TTL.
// Run as pi-monitor.service; state in ~/.pi/monitor/state.db.

import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { EC2Client } from "@aws-sdk/client-ec2";
import * as os from "node:os";
import * as path from "node:path";
import { checkAlarms } from "./monitor/checks/alarms.ts";
import { checkCost } from "./monitor/checks/cost.ts";
import { checkDrift } from "./monitor/checks/drift.ts";
import { checkLogs } from "./monitor/checks/logs.ts";
import { MonitorComs } from "./monitor/coms.ts";
import {
	DIAGNOSIS_RESPONSE_SCHEMA,
	type Diagnosis,
	type Finding,
	formatDigest,
	formatIncidentReport,
	parseDiagnoses,
} from "./monitor/report.ts";
import { MonitorState } from "./monitor/state.ts";

// Env-with-defaults configuration
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? "unknown";
const MONITOR_NAME = process.env.PI_MONITOR_NAME ?? `monitor-aws-${ACCOUNT_ID}`;
const REPORT_TO = process.env.PI_MONITOR_REPORT_TO ?? "laptop";
const REPORT_TTL_MS = Number(process.env.PI_MONITOR_REPORT_TTL_MS ?? 1_209_600_000);
const CHECK_CRON = process.env.PI_MONITOR_CHECK_CRON ?? "*/15 * * * *";
const DAILY_CRON = process.env.PI_MONITOR_DAILY_CRON ?? "@daily";
const INVESTIGATE_TARGET = process.env.PI_MONITOR_INVESTIGATE_TARGET ?? `aws-${ACCOUNT_ID}`;
const INVESTIGATE_TIMEOUT_MS = Number(process.env.PI_MONITOR_INVESTIGATE_TIMEOUT_MS ?? 300_000);
const INVESTIGATE_PER_FINDING_MS = Number(
	process.env.PI_MONITOR_INVESTIGATE_PER_FINDING_MS ?? 60_000,
);
const INVESTIGATE_MAX_MS = Number(process.env.PI_MONITOR_INVESTIGATE_MAX_MS ?? 1_800_000);

// A flat await discards an agent's completed work whenever the batch is big
// enough to outrun it (observed: 19 findings vs the 5-min default). Scale the
// budget with the batch, capped so one huge batch cannot stall cycles all day.
export function investigateBudgetMs(
	findingCount: number,
	baseMs = INVESTIGATE_TIMEOUT_MS,
	perFindingMs = INVESTIGATE_PER_FINDING_MS,
	maxMs = INVESTIGATE_MAX_MS,
): number {
	return Math.min(baseMs + perFindingMs * findingCount, maxMs);
}
const COST_PCT = Number(process.env.PI_MONITOR_COST_PCT ?? 20);
const COST_ABS = Number(process.env.PI_MONITOR_COST_ABS ?? 1);
const STATE_DB =
	process.env.PI_MONITOR_STATE_DB ?? path.join(os.homedir(), ".pi", "monitor", "state.db");

export type InvestigationOutcome = {
	diagnoses: Map<string, Diagnosis> | null;
	failure: string | null;
};

export type CycleDeps = {
	checks: { name: string; run: () => Promise<Finding[]> }[];
	state: MonitorState;
	investigate:
		| ((findings: Finding[], priorContext: string) => Promise<InvestigationOutcome>)
		| null;
	report: (text: string) => Promise<void>;
	log: (line: string) => void;
};

export async function runCycle(deps: CycleDeps): Promise<{ findings: Finding[] }> {
	const findings: Finding[] = [];
	for (const c of deps.checks) {
		try {
			findings.push(...(await c.run()));
		} catch (e: any) {
			deps.state.journal("check_error", { check: c.name, error: String(e?.message ?? e) });
			deps.log(`check ${c.name} failed: ${e?.message ?? e}`);
		}
	}

	if (findings.length > 0) {
		const toInvestigate = findings.filter((f) => f.severity !== "info");
		let diagnoses: Map<string, Diagnosis> | null = null;
		let investigationFailure: string | null = null;
		if (toInvestigate.length > 0 && deps.investigate) {
			const prior = toInvestigate
				.flatMap((f) => deps.state.priorIncidents(f.resource, 3))
				.map((r) => `${r.ts}: ${r.payload}`)
				.join("\n");
			try {
				const outcome = await deps.investigate(toInvestigate, prior);
				diagnoses = outcome.diagnoses;
				investigationFailure = outcome.failure;
			} catch (e: any) {
				diagnoses = null;
				investigationFailure = `investigate threw: ${e?.message ?? e}`;
			}
			if (investigationFailure) deps.log(`investigation failed: ${investigationFailure}`);
		}
		for (const f of findings) {
			deps.state.journal("finding", { ...f, diagnosis: diagnoses?.get(f.dedup_key) ?? null });
		}
		const text = formatIncidentReport(
			ACCOUNT_ID,
			findings.map((f) => ({ finding: f, diagnosis: diagnoses?.get(f.dedup_key) ?? null })),
			investigationFailure,
		);
		try {
			await deps.report(text);
		} catch (e: any) {
			deps.state.queueUnsent(REPORT_TO, text, REPORT_TTL_MS);
			deps.log(`report failed, queued locally: ${e?.message ?? e}`);
		}
	}

	// Retry anything the hub could not take earlier.
	for (const u of deps.state.unsent()) {
		try {
			await deps.report(u.prompt);
			deps.state.deleteUnsent(u.id);
		} catch {
			break; // hub still unreachable; keep order, try next cycle
		}
	}

	deps.state.journal("run", { findings: findings.length });
	return { findings };
}

// Serializes runs across trigger sources (cron tick, run-checks command).
// Bun.cron already guarantees no overlap per job; this covers cross-source
// overlap by skipping, not queueing.
export function makeGuard(): (fn: () => Promise<void>) => Promise<void> {
	let running = false;
	return async (fn) => {
		if (running) return;
		running = true;
		try {
			await fn();
		} finally {
			running = false;
		}
	};
}

function main(): void {
	const region = process.env.AWS_REGION;
	const state = new MonitorState(STATE_DB);
	const cw = new CloudWatchClient({ region });
	const logs = new CloudWatchLogsClient({ region });
	const ec2 = new EC2Client({ region });
	const ce = new CostExplorerClient({ region: "us-east-1" }); // Cost Explorer is us-east-1 only
	const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

	// Assigned after construction; the onPrompt closure runs only once the SSE
	// stream is open, well after assignment.
	let handleCommand: (prompt: string) => Promise<string> = async () => "monitor still starting";

	const coms = new MonitorComs({
		serverUrl: process.env.PI_COMS_NET_SERVER_URL ?? "http://127.0.0.1:8787",
		token: process.env.PI_COMS_NET_AUTH_TOKEN ?? "",
		project: process.env.PI_COMS_NET_PROJECT ?? process.env.COMS_PROJECT ?? "default",
		name: MONITOR_NAME,
		purpose: `Deterministic AWS monitor for account ${ACCOUNT_ID}`,
		onPrompt: async (p) => handleCommand(p.prompt),
	});

	const investigate = async (
		findings: Finding[],
		prior: string,
	): Promise<Map<string, Diagnosis> | null> => {
		const prompt = [
			`You are the read-only devops agent for AWS account ${ACCOUNT_ID}. The account monitor detected these findings; investigate with your AWS tools and diagnose each one.`,
			'Reply ONLY with JSON matching the response schema: an object {"diagnoses": [...]} with one entry per dedup_key.',
			"",
			"Findings:",
			JSON.stringify(findings, null, 2),
			prior ? `\nPrior incidents from the monitor journal:\n${prior}` : "",
		].join("\n");
		try {
			const sent = await coms.send(INVESTIGATE_TARGET, prompt, {
				response_schema: DIAGNOSIS_RESPONSE_SCHEMA,
			});
			const reply = await coms.awaitReply(sent.msg_id, investigateBudgetMs(findings.length));
			if (reply.error) return { diagnoses: null, failure: `agent reply error: ${reply.error}` };
			if (reply.response == null) return { diagnoses: null, failure: "agent reply empty" };
			const diagnoses = parseDiagnoses(reply.response);
			if (!diagnoses) return { diagnoses: null, failure: "agent reply did not match the diagnosis schema" };
			return { diagnoses, failure: null };
		} catch (e: any) {
			return { diagnoses: null, failure: `send to ${INVESTIGATE_TARGET} failed: ${e?.message ?? e}` };
		}
	};

	const report = async (text: string): Promise<void> => {
		await coms.send(REPORT_TO, text, { ttl_ms: REPORT_TTL_MS });
	};

	const fifteenDeps: CycleDeps = {
		checks: [
			{ name: "alarms", run: () => checkAlarms(cw, state) },
			{ name: "logs", run: () => checkLogs(logs, state) },
			{ name: "drift", run: () => checkDrift(ec2, state) },
		],
		state,
		investigate,
		report,
		log,
	};

	const buildDigest = async (): Promise<string> => {
		const day = 86_400_000;
		const findingRows = state.journalRows(day, "finding");
		const counts: Record<string, number> = {};
		for (const r of findingRows) {
			const fam = (JSON.parse(r.payload) as Finding).family;
			counts[fam] = (counts[fam] ?? 0) + 1;
		}
		let activeAlarms: string[] = [];
		try {
			const resp = await cw.send(new DescribeAlarmsCommand({ StateValue: "ALARM" }));
			activeAlarms = (resp.MetricAlarms ?? []).map((a: any) => a.AlarmName);
		} catch {
			// digest still ships
		}
		const latest = state.latestCost();
		return formatDigest({
			accountId: ACCOUNT_ID,
			since: new Date(Date.now() - day).toISOString(),
			findingCounts: counts,
			checkErrors: state.journalRows(day, "check_error").length,
			activeAlarms,
			yesterdayUsd: latest?.usd ?? null,
			baselineUsd: latest ? state.costBaseline(latest.date, 14) : null,
		});
	};

	const dailyDigest = async (): Promise<void> => {
		const costDeps: CycleDeps = {
			checks: [{ name: "cost", run: () => checkCost(ce, state, { pct: COST_PCT, abs: COST_ABS }) }],
			state,
			investigate,
			report,
			log,
		};
		await runCycle(costDeps);
		// The digest ships even when quiet; a missing digest is the dead-man signal.
		const text = await buildDigest();
		try {
			await report(text);
		} catch (e: any) {
			state.queueUnsent(REPORT_TO, text, REPORT_TTL_MS);
			log(`digest send failed, queued: ${e?.message ?? e}`);
		}
	};

	// Two guards, deliberately separate: @daily fires at midnight, which is
	// always also a */15 boundary. A single shared guard makes the collision a
	// silent skip -- whichever job wins the race suppresses the other, and the
	// digest never ships. Each guard still serializes its own job against the
	// run-checks command.
	const checkGuard = makeGuard();
	const dailyGuard = makeGuard();
	const runChecksNow = () => checkGuard(async () => void (await runCycle(fifteenDeps)));

	handleCommand = async (prompt: string): Promise<string> => {
		const cmd = prompt.trim().toLowerCase();
		if (cmd === "run-checks") {
			await runChecksNow();
			const last = state.journalRows(60_000, "run").at(-1);
			return `checks complete: ${last?.payload ?? "no run recorded"}`;
		}
		if (cmd === "status") {
			const lastRun = state.journalRows(7 * 86_400_000, "run").at(-1);
			return `monitor ${MONITOR_NAME} online. last run: ${lastRun ? `${lastRun.ts} ${lastRun.payload}` : "never"}. unsent reports: ${state.unsent().length}`;
		}
		if (cmd === "digest") return buildDigest();
		if (cmd.startsWith("history")) {
			const rows = state.journalRows(7 * 86_400_000, "finding").slice(-20);
			return rows.length === 0
				? "no findings in the last 7 days"
				: rows.map((r) => `${r.ts} ${r.payload}`).join("\n");
		}
		return "unknown command. available: run-checks, status, digest, history";
	};

	void (async () => {
		await coms.start();
		log(`registered as ${coms.name}; checks ${CHECK_CRON}; daily ${DAILY_CRON}; reporting to ${REPORT_TO}`);
		Bun.cron(CHECK_CRON, () => runChecksNow());
		Bun.cron(DAILY_CRON, () => dailyGuard(dailyDigest));
	})();

	const shutdown = () => {
		void coms.stop().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
	main();
}
