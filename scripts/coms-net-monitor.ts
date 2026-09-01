// scripts/coms-net-monitor.ts
//
// Per-host AWS account monitor. Deterministic scheduled checks (zero tokens
// when quiet); findings warn+ are investigated by the account's Pi agent over
// coms-net; reports mail to the operator via the hub mailbox with a long TTL.
// Run as pi-monitor.service; state in ~/.pi/monitor/state.db.

import { ACMClient } from "@aws-sdk/client-acm";
import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { EC2Client } from "@aws-sdk/client-ec2";
import { STSClient } from "@aws-sdk/client-sts";
import * as os from "node:os";
import * as path from "node:path";
import { checkAlarms } from "./monitor/checks/alarms.ts";
import { checkCerts } from "./monitor/checks/certs.ts";
import { checkCost } from "./monitor/checks/cost.ts";
import { checkDrift } from "./monitor/checks/drift.ts";
import { checkIdentity, type GateResult } from "./monitor/checks/identity.ts";
import { checkIngestion } from "./monitor/checks/ingestion.ts";
import { checkLogs } from "./monitor/checks/logs.ts";
import { checkTrail } from "./monitor/checks/trail.ts";
import { checkWatchlist } from "./monitor/checks/watchlist.ts";
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
// Minute 7 deliberately: never a */15 boundary, so the hourly guard cannot
// collide with the check guard (see the midnight-collision note below).
const HOURLY_CRON = process.env.PI_MONITOR_HOURLY_CRON ?? "7 * * * *";
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
const LOGS_FILTER = process.env.PI_MONITOR_LOGS_FILTER; // check default applies when unset
const LOGS_MAX_GROUPS = process.env.PI_MONITOR_LOGS_MAX_GROUPS
	? Number(process.env.PI_MONITOR_LOGS_MAX_GROUPS)
	: undefined;
const LOGS_EXCLUDE = (process.env.PI_MONITOR_LOGS_EXCLUDE ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const JOURNAL_RETAIN_MS =
	Number(process.env.PI_MONITOR_JOURNAL_RETAIN_DAYS ?? 90) * 86_400_000;
const INGEST_MIN_EVENTS = Number(process.env.PI_MONITOR_INGEST_MIN_EVENTS ?? 10);
const WATCHLIST = (process.env.PI_MONITOR_WATCHLIST ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const CERT_WARN_DAYS = Number(process.env.PI_MONITOR_CERT_WARN_DAYS ?? 30);
const CERT_CRIT_DAYS = Number(process.env.PI_MONITOR_CERT_CRIT_DAYS ?? 7);
const STATE_DB =
	process.env.PI_MONITOR_STATE_DB ?? path.join(os.homedir(), ".pi", "monitor", "state.db");

export type InvestigationOutcome = {
	diagnoses: Map<string, Diagnosis> | null;
	failure: string | null;
};

export type CycleDeps = {
	// T0: runs before everything; unhealthy skips the checks for this cycle
	// (a broken identity turns every check into correlated noise).
	gate?: { name: string; run: () => Promise<{ findings: Finding[]; healthy: boolean }> };
	checks: { name: string; run: () => Promise<Finding[]> }[];
	state: MonitorState;
	investigate:
		| ((findings: Finding[], priorContext: string) => Promise<InvestigationOutcome>)
		| null;
	report: (text: string) => Promise<void>;
	log: (line: string) => void;
};

export async function runCycle(
	deps: CycleDeps,
): Promise<{ findings: Finding[]; suppressed: number }> {
	const collected: Finding[] = [];
	let gated = false;
	if (deps.gate) {
		try {
			const g = await deps.gate.run();
			collected.push(...g.findings);
			gated = !g.healthy;
			if (gated) deps.log(`gate ${deps.gate.name} unhealthy: skipping checks this cycle`);
		} catch (e: any) {
			// A throwing gate is an unknown, not a proven failure: journal it and
			// let the checks report reality.
			deps.state.journal("check_error", { check: deps.gate.name, error: String(e?.message ?? e) });
			deps.log(`gate ${deps.gate.name} threw: ${e?.message ?? e}`);
		}
	}
	if (!gated) {
		for (const c of deps.checks) {
			try {
				collected.push(...(await c.run()));
			} catch (e: any) {
				deps.state.journal("check_error", { check: c.name, error: String(e?.message ?? e) });
				deps.log(`check ${c.name} failed: ${e?.message ?? e}`);
			}
		}
	}

	// Ledger pass: operator-accepted findings are history, not alerts.
	const findings: Finding[] = [];
	let suppressed = 0;
	for (const f of collected) {
		const m = deps.state.matchSuppression(f.dedup_key);
		if (m) {
			suppressed++;
			deps.state.journal("suppressed_finding", { ...f, suppressed_by: m.pattern, reason: m.reason });
		} else {
			findings.push(f);
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
			suppressed,
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

	deps.state.journal("run", { findings: findings.length, suppressed });
	return { findings, suppressed };
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
	const sts = new STSClient({ region });
	const cloudtrail = new CloudTrailClient({ region });
	const acm = new ACMClient({ region });
	const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

	const gate = {
		name: "identity",
		run: (): Promise<GateResult> => checkIdentity(sts, state, { expectedAccountId: ACCOUNT_ID }),
	};

	// Deploy canary for the digest: the bundle version this monitor is running.
	const bundleFile = path.resolve(import.meta.dir, "..", ".bundle-version");
	const bundleVersion = async (): Promise<string | null> => {
		try {
			const v = (await Bun.file(bundleFile).text()).trim();
			return v || null;
		} catch {
			return null; // dev checkout: no bundle file
		}
	};

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
		gate,
		checks: [
			{ name: "alarms", run: () => checkAlarms(cw, state) },
			{
				name: "logs",
				run: () =>
					checkLogs(logs, state, {
						filterPattern: LOGS_FILTER,
						maxGroups: LOGS_MAX_GROUPS,
						// Empty env means "use the check's default excludes", not
						// "exclude nothing".
						excludePrefixes: LOGS_EXCLUDE.length > 0 ? LOGS_EXCLUDE : undefined,
					}),
			},
			{ name: "drift", run: () => checkDrift(ec2, state) },
		],
		state,
		investigate,
		report,
		log,
	};

	const hourlyDeps: CycleDeps = {
		gate,
		checks: [
			{
				name: "ingestion",
				run: () =>
					checkIngestion(cw, state, {
						minEvents: INGEST_MIN_EVENTS,
						excludePrefixes: LOGS_EXCLUDE.length > 0 ? LOGS_EXCLUDE : undefined,
					}),
			},
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
			bundleVersion: await bundleVersion(),
			suppressedCount: state.journalRows(day, "suppressed_finding").length,
		});
	};

	const dailyDigest = async (): Promise<void> => {
		const dailyDeps: CycleDeps = {
			gate,
			checks: [
				{ name: "cost", run: () => checkCost(ce, state, { pct: COST_PCT, abs: COST_ABS }) },
				{ name: "trail", run: () => checkTrail(cloudtrail, state) },
				{ name: "certs", run: () => checkCerts(acm, state, { warnDays: CERT_WARN_DAYS, critDays: CERT_CRIT_DAYS }) },
				{
					name: "watchlist",
					run: () => checkWatchlist(cloudtrail, state, WATCHLIST.length > 0 ? { events: WATCHLIST } : {}),
				},
			],
			state,
			investigate,
			report,
			log,
		};
		await runCycle(dailyDeps);
		const pruned = state.pruneJournal(JOURNAL_RETAIN_MS);
		if (pruned > 0) log(`journal pruned: ${pruned} row(s) past retention`);
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
	const hourlyGuard = makeGuard();
	const dailyGuard = makeGuard();
	const runChecksNow = () => checkGuard(async () => void (await runCycle(fifteenDeps)));
	const runHourlyNow = () => hourlyGuard(async () => void (await runCycle(hourlyDeps)));

	handleCommand = async (prompt: string): Promise<string> => {
		const raw = prompt.trim();
		const cmd = raw.toLowerCase();
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
		if (cmd === "suppressions") {
			const rows = state.listSuppressions();
			return rows.length === 0
				? "suppression ledger is empty"
				: rows.map((r) => `${r.created_at} ${r.pattern} -- ${r.reason}`).join("\n");
		}
		if (cmd.startsWith("unsuppress ")) {
			const pattern = raw.slice("unsuppress ".length).trim();
			return state.removeSuppression(pattern)
				? `removed suppression: ${pattern}`
				: `no suppression matches: ${pattern}`;
		}
		if (cmd.startsWith("suppress ")) {
			// Pattern keeps its case (dedup keys carry alarm and group names);
			// SQL LIKE with % wildcards, e.g.: suppress alarm:%-Utilization-Low-20% | accepted dev rightsizing noise
			const rest = raw.slice("suppress ".length);
			const sep = rest.indexOf("|");
			const pattern = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
			const reason = sep >= 0 ? rest.slice(sep + 1).trim() : "";
			if (!pattern || !reason) {
				return "usage: suppress <dedup-key LIKE pattern> | <reason>";
			}
			state.addSuppression(pattern, reason);
			return `suppressed: ${pattern} (${reason})`;
		}
		return "unknown command. available: run-checks, status, digest, history, suppressions, suppress <pattern> | <reason>, unsuppress <pattern>";
	};

	void (async () => {
		await coms.start();
		log(
			`registered as ${coms.name}; checks ${CHECK_CRON}; hourly ${HOURLY_CRON}; daily ${DAILY_CRON}; reporting to ${REPORT_TO}`,
		);
		Bun.cron(CHECK_CRON, () => runChecksNow());
		Bun.cron(HOURLY_CRON, () => runHourlyNow());
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
