// scripts/monitor/state.ts
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export class MonitorState {
	private db: Database;
	constructor(dbPath: string) {
		if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS watermarks (key TEXT PRIMARY KEY, ts INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS fingerprints (key TEXT PRIMARY KEY, family TEXT NOT NULL, first_alerted INTEGER NOT NULL, last_alerted INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS snapshots (name TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS costs (date TEXT PRIMARY KEY, usd REAL NOT NULL);
			CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS unsent (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, prompt TEXT NOT NULL, ttl_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
		`);
	}
	close(): void {
		try {
			this.db.close();
		} catch {
			// noop
		}
	}

	getWatermark(key: string): number | null {
		const r = this.db.query("SELECT ts FROM watermarks WHERE key = ?").get(key) as any;
		return r ? Number(r.ts) : null;
	}
	setWatermark(key: string, ts: number): void {
		this.db.query(
			"INSERT INTO watermarks (key, ts) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts",
		).run(key, ts);
	}

	// true when never alerted, or when reAlertMs is given and the last alert is
	// older than it. Omitted reAlertMs means alert once until cleared.
	shouldAlert(key: string, reAlertMs?: number): boolean {
		const r = this.db.query("SELECT last_alerted FROM fingerprints WHERE key = ?").get(key) as any;
		if (!r) return true;
		if (reAlertMs === undefined) return false;
		return Date.now() - Number(r.last_alerted) > reAlertMs;
	}
	markAlerted(key: string, family: string): void {
		const now = Date.now();
		this.db.query(
			`INSERT INTO fingerprints (key, family, first_alerted, last_alerted) VALUES (?, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET last_alerted = excluded.last_alerted`,
		).run(key, family, now, now);
	}
	clearAlerts(prefix: string): void {
		this.db.query("DELETE FROM fingerprints WHERE key LIKE ? || '%'").run(prefix);
	}
	alertKeys(prefix: string): string[] {
		return (
			this.db.query("SELECT key FROM fingerprints WHERE key LIKE ? || '%' ORDER BY key").all(prefix) as any[]
		).map((r) => r.key);
	}

	getSnapshot(name: string): Record<string, string> | null {
		const r = this.db.query("SELECT value FROM snapshots WHERE name = ?").get(name) as any;
		return r ? JSON.parse(r.value) : null;
	}
	setSnapshot(name: string, v: Record<string, string>): void {
		this.db.query(
			"INSERT INTO snapshots (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
		).run(name, JSON.stringify(v));
	}

	recordCost(date: string, usd: number): void {
		this.db.query(
			"INSERT INTO costs (date, usd) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET usd = excluded.usd",
		).run(date, usd);
	}
	costBaseline(excludeDate: string, days: number): number | null {
		const rows = this.db.query(
			"SELECT usd FROM costs WHERE date < ? ORDER BY date DESC LIMIT ?",
		).all(excludeDate, days) as any[];
		if (rows.length === 0) return null;
		return rows.reduce((a, r) => a + Number(r.usd), 0) / rows.length;
	}
	latestCost(): { date: string; usd: number } | null {
		const r = this.db.query("SELECT date, usd FROM costs ORDER BY date DESC LIMIT 1").get() as any;
		return r ? { date: r.date, usd: Number(r.usd) } : null;
	}

	journal(kind: string, payload: unknown): void {
		const now = new Date();
		this.db.query("INSERT INTO journal (ts, ts_ms, kind, payload) VALUES (?, ?, ?, ?)").run(
			now.toISOString(),
			now.getTime(),
			kind,
			JSON.stringify(payload),
		);
	}
	journalRows(sinceMs: number, kind?: string): { ts: string; kind: string; payload: string }[] {
		const cutoff = Date.now() - sinceMs;
		const rows = kind
			? this.db.query("SELECT ts, kind, payload FROM journal WHERE ts_ms >= ? AND kind = ? ORDER BY id ASC").all(cutoff, kind)
			: this.db.query("SELECT ts, kind, payload FROM journal WHERE ts_ms >= ? ORDER BY id ASC").all(cutoff);
		return rows as any[];
	}
	priorIncidents(resource: string, limit: number): { ts: string; payload: string }[] {
		return this.db.query(
			"SELECT ts, payload FROM journal WHERE kind = 'finding' AND payload LIKE '%' || ? || '%' ORDER BY id DESC LIMIT ?",
		).all(resource, limit) as any[];
	}

	queueUnsent(target: string, prompt: string, ttlMs: number): void {
		this.db.query("INSERT INTO unsent (target, prompt, ttl_ms, created_at) VALUES (?, ?, ?, ?)").run(
			target,
			prompt,
			ttlMs,
			new Date().toISOString(),
		);
	}
	unsent(): { id: number; target: string; prompt: string; ttl_ms: number }[] {
		return this.db.query("SELECT id, target, prompt, ttl_ms FROM unsent ORDER BY id ASC").all() as any[];
	}
	deleteUnsent(id: number): void {
		this.db.query("DELETE FROM unsent WHERE id = ?").run(id);
	}
}
