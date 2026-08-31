// scripts/monitor/report.ts
import { z } from "zod";

export const SeveritySchema = z.enum(["info", "warn", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;
export const FamilySchema = z.enum(["alarm", "logs", "drift", "cost"]);
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

export function formatIncidentReport(
	accountId: string,
	items: { finding: Finding; diagnosis: Diagnosis | null }[],
	investigationFailure?: string | null,
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
	return lines.join("\n");
}

export type DigestInput = {
	accountId: string;
	since: string;
	findingCounts: Record<string, number>;
	checkErrors: number;
	activeAlarms: string[];
	yesterdayUsd: number | null;
	baselineUsd: number | null;
};

export function formatDigest(d: DigestInput): string {
	const total = Object.values(d.findingCounts).reduce((a, b) => a + b, 0);
	const lines: string[] = [`[info] aws-${d.accountId} daily digest (since ${d.since})`, ""];
	if (total === 0) {
		lines.push("- findings: no findings in the last 24h");
	} else {
		const parts = Object.entries(d.findingCounts).map(([k, v]) => `${k}=${v}`).join(" ");
		lines.push(`- findings: ${total} (${parts})`);
	}
	lines.push(`- check errors: ${d.checkErrors}`);
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
	return lines.join("\n");
}
