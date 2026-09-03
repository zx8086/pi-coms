// scripts/monitor/report.ts
import { z } from "zod";

export const SeveritySchema = z.enum(["info", "warn", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;
export const FamilySchema = z.enum([
	"alarm",
	"logs",
	"drift",
	"cost",
	"identity",
	"ingestion",
	"trail",
	"cert",
	"watchlist",
]);
export type Family = z.infer<typeof FamilySchema>;

export const FindingSchema = z.object({
	family: FamilySchema,
	severity: SeveritySchema,
	resource: z.string(),
	summary: z.string(),
	dedup_key: z.string(),
	evidence: z.unknown(),
	at: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const DiagnosisSchema = z.object({
	probable_cause: z.string(),
	affected_resources: z.array(z.string()),
	suggested_action: z.string(),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

// JSON schema handed to the Pi agent via coms response_schema.
export const DIAGNOSIS_RESPONSE_SCHEMA = {
	type: "object",
	required: ["diagnoses"],
	properties: {
		diagnoses: {
			type: "array",
			items: {
				type: "object",
				required: ["dedup_key", "probable_cause", "affected_resources", "suggested_action"],
				properties: {
					dedup_key: { type: "string" },
					probable_cause: { type: "string" },
					affected_resources: { type: "array", items: { type: "string" } },
					suggested_action: { type: "string" },
				},
			},
		},
	},
} as const;

const DiagnosesEnvelope = z.object({
	diagnoses: z.array(DiagnosisSchema.extend({ dedup_key: z.string() })),
});

export function parseDiagnoses(raw: unknown): Map<string, Diagnosis> | null {
	const parsed = DiagnosesEnvelope.safeParse(raw);
	if (!parsed.success) return null;
	const map = new Map<string, Diagnosis>();
	for (const d of parsed.data.diagnoses) {
		const { dedup_key, ...rest } = d;
		map.set(dedup_key, rest);
	}
	return map;
}

const SEV_ORDER: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };
const NOTABLE_CAP = 10;

export function formatIncidentReport(
	accountId: string,
	items: { finding: Finding; diagnosis: Diagnosis | null }[],
	investigationFailure?: string | null,
	suppressedCount = 0,
): string {
	const sorted = [...items].sort(
		(a, b) => SEV_ORDER[a.finding.severity] - SEV_ORDER[b.finding.severity],
	);
	const top = sorted[0]?.finding.severity ?? "info";
	const lines: string[] = [`[${top}] aws-${accountId}: ${sorted.length} finding(s)`, ""];
	for (const { finding, diagnosis } of sorted) {
		lines.push(`- (${finding.severity}/${finding.family}) ${finding.resource}: ${finding.summary}`);
		if (diagnosis) {
			lines.push(`  cause: ${diagnosis.probable_cause}`);
			if (diagnosis.affected_resources.length > 0) {
				lines.push(`  affected: ${diagnosis.affected_resources.join(", ")}`);
			}
			lines.push(`  action: ${diagnosis.suggested_action}`);
		} else if (finding.severity !== "info") {
			lines.push(`  (uninvestigated: ${investigationFailure ?? "agent unavailable or response invalid"})`);
		}
		lines.push(`  evidence: ${JSON.stringify(finding.evidence)}`);
	}
	if (suppressedCount > 0) {
		lines.push("", `suppressed: ${suppressedCount} finding(s) matching the ledger (journaled, not investigated)`);
	}
	return lines.join("\n");
}

export type DigestNotable = {
	severity: Severity;
	family: Family;
	resource: string;
	summary: string;
	uninvestigated: boolean;
};

// A journaled finding row carries the finding plus the diagnosis it was (or
// wasn't) investigated with; a null diagnosis at warn+ is itself a signal.
export function notablesFromJournal(rows: { payload: string }[]): DigestNotable[] {
	const notables: DigestNotable[] = [];
	for (const r of rows) {
		let payload: unknown;
		try {
			payload = JSON.parse(r.payload);
		} catch {
			continue;
		}
		const parsed = FindingSchema.safeParse(payload);
		if (!parsed.success || parsed.data.severity === "info") continue;
		notables.push({
			severity: parsed.data.severity,
			family: parsed.data.family,
			resource: parsed.data.resource,
			summary: parsed.data.summary,
			uninvestigated: (payload as { diagnosis?: unknown }).diagnosis == null,
		});
	}
	return notables;
}

export type DigestInput = {
	accountId: string;
	since: string;
	findingCounts: Record<string, number>;
	checkErrors: number;
	checkErrorsByCheck?: Record<string, number>;
	activeAlarms: string[];
	yesterdayUsd: number | null;
	baselineUsd: number | null;
	bundleVersion?: string | null;
	suppressedCount?: number;
	notables?: DigestNotable[];
};

export function formatDigest(d: DigestInput): string {
	const total = Object.values(d.findingCounts).reduce((a, b) => a + b, 0);
	// A green digest produced while checks errored is a lie: degradation is
	// the headline, not a line item.
	const header =
		d.checkErrors > 0
			? `[warn] aws-${d.accountId} daily digest DEGRADED: ${d.checkErrors} check error(s) (since ${d.since})`
			: `[info] aws-${d.accountId} daily digest (since ${d.since})`;
	const lines: string[] = [header, ""];
	if (total === 0) {
		lines.push("- findings: no findings in the last 24h");
	} else {
		const parts = Object.entries(d.findingCounts).map(([k, v]) => `${k}=${v}`).join(" ");
		lines.push(`- findings: ${total} (${parts})`);
	}
	// Counts alone hide what actually needs follow-up: name every warn+
	// finding so the digest is reviewable without a journal round-trip.
	const notables = (d.notables ?? [])
		.filter((n) => n.severity !== "info")
		.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
	if (notables.length > 0) {
		lines.push("- notable warn+ findings (last 24h):");
		for (const n of notables.slice(0, NOTABLE_CAP)) {
			const marker = n.uninvestigated ? " [uninvestigated]" : "";
			lines.push(`  - (${n.severity}/${n.family}) ${n.resource}: ${n.summary}${marker}`);
		}
		if (notables.length > NOTABLE_CAP) {
			lines.push(`  - +${notables.length - NOTABLE_CAP} more warn+ finding(s) in the journal`);
		}
		const uninvestigated = notables.filter((n) => n.uninvestigated).length;
		if (uninvestigated > 0) lines.push(`- uninvestigated: ${uninvestigated}`);
	}
	// DEGRADED must be self-explanatory from the mailbox: name the failing
	// family, not just the count.
	const byCheck = Object.entries(d.checkErrorsByCheck ?? {});
	lines.push(
		byCheck.length > 0
			? `- check errors: ${d.checkErrors} (${byCheck.map(([k, v]) => `${k}=${v}`).join(" ")})`
			: `- check errors: ${d.checkErrors}`,
	);
	lines.push(
		d.activeAlarms.length === 0
			? "- alarms: none in ALARM"
			: `- alarms in ALARM: ${d.activeAlarms.join(", ")}`,
	);
	if (d.yesterdayUsd != null) {
		const base = d.baselineUsd != null ? ` vs 14d baseline $${d.baselineUsd.toFixed(2)}` : "";
		lines.push(`- spend yesterday: $${d.yesterdayUsd.toFixed(2)}${base}`);
	} else {
		lines.push("- spend: no cost data yet");
	}
	if ((d.suppressedCount ?? 0) > 0) lines.push(`- suppressed by ledger: ${d.suppressedCount}`);
	// Deploy canary: a stale bundle silently drops capabilities; the digest is
	// where the operator sees the version without an SSM round-trip.
	lines.push(`- bundle: ${d.bundleVersion ?? "unknown"}`);
	return lines.join("\n");
}
