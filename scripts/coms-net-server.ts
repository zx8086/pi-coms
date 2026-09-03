// scripts/coms-net-server.ts
//
// coms-net Bun HTTP/SSE hub server (v1).
//
// Implements the protocol defined in specs/coms-net-v1.md.
//
// Hard rules:
// - Entrypoint guard: Bun.serve boot lives inside main(); only fires when
//   `import.meta.main` is true. `bun -e "import('...')"` must NOT start the server.
// - Token policy:
//     * PI_COMS_NET_AUTH_TOKEN set -> use it; do NOT write server.secret.json.
//     * Loopback bind w/o env token -> generate random, write server.secret.json (0600).
//     * Non-loopback bind w/o env token -> fail startup (exit 1).
// - Never log the auth token. Print only the *path* to server.secret.json.
// - crypto.timingSafeEqual is length-guarded.
// - Atomic writes via .tmp + renameSync.
// - SIGINT/SIGTERM unlinks server.json (always best-effort) and server.secret.json
//   only if TOKEN_FILE_OWNED_BY_US is true.
// - Status state machine: queued | delivered | complete | error | timeout.
//   No `in_progress` (dropped from v1).

import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Env-var reads (module scope; all tunables here)
// ─────────────────────────────────────────────────────────────────────────────

const HOST = process.env.PI_COMS_NET_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PI_COMS_NET_PORT ?? 0);
const PUBLIC_URL = process.env.PI_COMS_NET_PUBLIC_URL;
const PROJECT = process.env.PI_COMS_NET_PROJECT ?? "default";
const ENV_TOKEN = process.env.PI_COMS_NET_AUTH_TOKEN;
const REG_ROOT = path.join(os.homedir(), ".pi", "coms-net");

const MAX_HOPS = Number(process.env.PI_COMS_NET_MAX_HOPS ?? 5);
const MESSAGE_TTL_MS = Number(process.env.PI_COMS_NET_MESSAGE_TTL_MS ?? 1_800_000);
const MAX_TTL_MS = Number(process.env.PI_COMS_NET_MAX_TTL_MS ?? 1_209_600_000);
const MAX_INBOX = Number(process.env.PI_COMS_NET_MAX_INBOX ?? 100);
const HEARTBEAT_MS = Number(process.env.PI_COMS_NET_HEARTBEAT_MS ?? 10_000);
const STALE_AFTER_MS = Number(process.env.PI_COMS_NET_STALE_AFTER_MS ?? 30_000);
const OFFLINE_AFTER_MS = Number(process.env.PI_COMS_NET_OFFLINE_AFTER_MS ?? 60_000);
// Largest accepted request body; Bun answers 413 above it (prompts are KB-scale).
const MAX_BODY_BYTES = Number(process.env.PI_COMS_NET_MAX_BODY_BYTES ?? 1_048_576);

// Per-principal token directory (SIO-1577). Either source activates directory
// mode; neither keeps the legacy single shared token exactly as before.
const AUTH_FILE = process.env.PI_COMS_NET_AUTH_FILE;
const AUTH_SSM_PATH = process.env.PI_COMS_NET_AUTH_SSM_PATH;
const AUTH_REFRESH_MS = Number(process.env.PI_COMS_NET_AUTH_REFRESH_MS ?? 60_000);
const DIRECTORY_MODE = Boolean(AUTH_FILE || AUTH_SSM_PATH);

const STALE_SCAN_INTERVAL_MS = 5_000;
const TTL_SCAN_INTERVAL_MS = 10_000;
const SSE_KEEPALIVE_MS = 15_000;
const DEFAULT_AWAIT_TIMEOUT_MS = 30_000;

let TOKEN: string = ENV_TOKEN ?? "";
let TOKEN_FILE_OWNED_BY_US = false;

// ─────────────────────────────────────────────────────────────────────────────
// Console event logger
// ─────────────────────────────────────────────────────────────────────────────
// Concise, color-coded per-event lines so the operator can watch what's
// flowing through the hub. Uses ANSI 24-bit colors when stdout is a TTY,
// otherwise plain ASCII. Auth tokens NEVER appear here.
//
// Format: HH:MM:SS.sss <symbol> <kind:10> <detail>
//
// Set PI_COMS_NET_LOG_HEARTBEAT=1 to also see heartbeats (very chatty).
// Set PI_COMS_NET_LOG_QUIET=1 to suppress everything except startup/shutdown.

const LOG_TTY = process.stdout.isTTY === true;
const LOG_QUIET = process.env.PI_COMS_NET_LOG_QUIET === "1";
const LOG_HEARTBEAT = process.env.PI_COMS_NET_LOG_HEARTBEAT === "1";

const C_DIM    = LOG_TTY ? "\x1b[2m"  : "";
const C_RESET  = LOG_TTY ? "\x1b[0m"  : "";
const C_GREEN  = LOG_TTY ? "\x1b[32m" : "";
const C_CYAN   = LOG_TTY ? "\x1b[36m" : "";
const C_YELLOW = LOG_TTY ? "\x1b[33m" : "";
const C_RED    = LOG_TTY ? "\x1b[31m" : "";
const C_PINK   = LOG_TTY ? "\x1b[95m" : "";
const C_BLUE   = LOG_TTY ? "\x1b[34m" : "";

function logLine(symbol: string, color: string, kind: string, detail: string): void {
	if (LOG_QUIET) return;
	const t = new Date().toISOString().slice(11, 23); // HH:MM:SS.sss
	const padded = kind.padEnd(10);
	console.log(`${C_DIM}${t}${C_RESET}  ${color}${symbol}${C_RESET} ${color}${padded}${C_RESET} ${detail}`);
}

const tail6 = (id: string) => id.length > 6 ? id.slice(-6) : id;
const dim = (s: string) => `${C_DIM}${s}${C_RESET}`;

function logRegister(name: string, project: string, sid: string, isReregister: boolean, principal?: string): void {
	const verb = isReregister ? "re-register" : "register";
	const who = principal ? ` ${dim("principal=" + principal)}` : "";
	logLine(isReregister ? "↻" : "✓", C_GREEN, verb, `${name}@${project} ${dim("sid=…" + tail6(sid))}${who}`);
}
function logUnregister(name: string, reason: string): void {
	logLine("✗", C_RED, "unregister", `${name} ${dim("reason=" + reason)}`);
}
function logSseOpen(name: string, totalStreams: number): void {
	logLine("⇄", C_CYAN, "sse-open", `${name} ${dim(`(${totalStreams} stream${totalStreams === 1 ? "" : "s"})`)}`);
}
function logSseClose(name: string, reason: string): void {
	logLine("⇄", C_DIM, "sse-close", `${name} ${dim("reason=" + reason)}`);
}
function logMessageSend(sender: string, target: string, msgId: string, prompt: string, hops: number, delivered: boolean): void {
	const preview = prompt.length > 50 ? prompt.slice(0, 47) + "…" : prompt;
	const safePreview = preview.replace(/\n/g, " ⏎ ");
	const status = delivered ? dim("delivered") : dim("queued");
	logLine("→", C_PINK, "message", `${sender} → ${target} ${dim(tail6(msgId))} "${safePreview}" ${dim(`hops=${hops}`)} ${status}`);
}
function logResponse(responder: string, sender: string, msgId: string, isError: boolean, error: string | null, size: number): void {
	const status = isError ? `${C_RED}error=${error}${C_RESET}` : dim(`${size}c`);
	logLine("←", isError ? C_RED : C_GREEN, "response", `${responder} → ${sender} ${dim(tail6(msgId))} ${status}`);
}
function logStale(name: string, dtSec: number): void {
	logLine("⚠", C_YELLOW, "stale", `${name} ${dim(`(${dtSec}s since last heartbeat)`)}`);
}
function logOffline(name: string): void {
	logLine("⌛", C_RED, "offline", `${name} ${dim("removed (no heartbeat)")}`);
}
function logExpired(msgId: string): void {
	logLine("⏱", C_YELLOW, "expired", dim(tail6(msgId)));
}
function logTargetDied(msgId: string, target: string, reason: string): void {
	logLine("✗", C_RED, "target-died", `${dim(tail6(msgId))} target=${target} ${dim("reason=" + reason)}`);
}
function logHeartbeat(name: string, pct: number, depth: number): void {
	if (!LOG_HEARTBEAT) return;
	logLine("♥", C_BLUE, "heartbeat", `${name} ${dim(`ctx=${pct}% queue=${depth}`)}`);
}
function logRejected(reason: string, detail: string): void {
	logLine("✗", C_YELLOW, "rejected", `${reason} ${dim(detail)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared types (paste into both server and client per spec)
// ─────────────────────────────────────────────────────────────────────────────

export type AgentStatus = "online" | "stale" | "offline";
export type MessageStatus =
	| "queued"
	| "delivered"
	| "complete"
	| "error"
	| "timeout";

export type AgentCard = {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	provider?: string;
	color: string;
	cwd: string;
	project: string;
	explicit: boolean;
	started_at: string;
	context_used_pct: number;
	queue_depth: number;
	status: AgentStatus;
};

export type RegistryEntry = AgentCard & {
	last_seen_at: string;
	registered_at: string;
	token_hash?: string; // directory-mode sessions carry their token hash for revocation
	principal?: string;
};

export type ComsMessage = {
	msg_id: string;
	project: string;
	sender_session: string;
	sender_name: string;
	sender_cwd: string;
	target_session: string | null; // null = queued by name, unclaimed
	target_name: string | null;
	prompt: string;
	conversation_id: string | null;
	response_schema: object | null;
	hops: number;
	status: MessageStatus;
	mailbox: boolean; // requested TTL beyond the default: retained as inbox history until expiry
	response?: any;
	error?: string | null;
	created_at: string;
	delivered_at?: string;
	completed_at?: string;
	expires_at: string;
};

export type RegisterRequest = {
	project: string;
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	provider?: string;
	color: string;
	cwd: string;
	explicit: boolean;
};

export type RegisterResponse = {
	ok: true;
	agent: AgentCard;
	heartbeat_interval_ms: number;
	sse_url: string;
};

export type HeartbeatRequest = {
	project: string;
	context_used_pct: number;
	queue_depth: number;
	model?: string;
	status?: AgentStatus;
};

export type SendRequest = {
	project: string;
	sender_session: string;
	target: string;
	target_session: string | null;
	prompt: string;
	conversation_id: string | null;
	response_schema: object | null;
	hops: number;
	ttl_ms?: number | null;
};

export type SendResponse = {
	ok: true;
	msg_id: string;
	status: MessageStatus;
	target_session: string | null;
};

export type ResponseSubmitRequest = {
	project: string;
	responder_session: string;
	response: any;
	error: string | null;
};

export type ErrorResponse = { ok: false; error: string; details?: any };

// SSE writer & per-project state
type Awaiter = {
	resolve: (m: ComsMessage) => void;
	timer: ReturnType<typeof setTimeout> | null;
};

type SseWriter = {
	session_id: string;
	enqueue: (frame: string) => void;
	close: () => void;
	lastId: number;
};

type ProjectState = {
	agents: Map<string, RegistryEntry>;
	nameIndex: Map<string, Set<string>>;
	messages: Map<string, ComsMessage>;
	streams: Map<string, SseWriter>;
	awaiters: Map<string, Set<Awaiter>>;
};

type ServerState = {
	server_id: string;
	started_at: string;
	projects: Map<string, ProjectState>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (module scope, all pure / deterministic)
// ─────────────────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function tokensEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf-8");
	const bb = Buffer.from(b, "utf-8");
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

// ── Per-principal auth (SIO-1577) ───────────────────────────────────────────

export type AuthPrincipal = { principal: string; kind: string; names: string[] };
type AuthResult = { principal: AuthPrincipal; token_hash: string | null };

const ROOT_PRINCIPAL: AuthPrincipal = { principal: "root", kind: "root", names: ["*"] };
const LEGACY_PRINCIPAL: AuthPrincipal = { principal: "shared", kind: "legacy", names: ["*"] };

// sha256 hashes are the only token representation kept in memory long-term.
let tokenDirectory = new Map<string, AuthPrincipal>();

function sha256hex(s: string): string {
	return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

// Name patterns: exact, "prefix-*", or "*".
export function nameAllowed(p: { names: string[] }, name: string): boolean {
	for (const pat of p.names) {
		if (pat === "*") return true;
		if (pat.endsWith("-*")) {
			if (name.startsWith(pat.slice(0, -1))) return true;
		} else if (pat === name) {
			return true;
		}
	}
	return false;
}

function parseDirectoryEntries(principals: Record<string, any> | undefined): Map<string, AuthPrincipal> {
	const map = new Map<string, AuthPrincipal>();
	for (const [principal, rec] of Object.entries(principals ?? {})) {
		if (!rec || typeof rec.token !== "string" || rec.token.length < 16) continue;
		const names = Array.isArray(rec.names)
			? rec.names.filter((n: unknown): n is string => typeof n === "string")
			: [];
		map.set(sha256hex(rec.token), {
			principal,
			kind: typeof rec.kind === "string" ? rec.kind : "operator",
			names,
		});
	}
	return map;
}

async function refreshTokenDirectory(): Promise<void> {
	if (!DIRECTORY_MODE) return;
	let next: Map<string, AuthPrincipal> | null = null;
	try {
		if (AUTH_FILE) {
			const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
			next = parseDirectoryEntries(parsed.principals);
		} else if (AUTH_SSM_PATH) {
			// The hub stays Bun-stdlib-only; SSM access rides the host's aws CLI.
			const proc = Bun.spawn(
				["aws", "ssm", "get-parameters-by-path", "--path", AUTH_SSM_PATH,
					"--with-decryption", "--recursive", "--output", "json"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const out = await new Response(proc.stdout).text();
			await proc.exited;
			if (proc.exitCode !== 0) throw new Error(`aws ssm exited ${proc.exitCode}`);
			const parsed = JSON.parse(out);
			const principals: Record<string, any> = {};
			for (const p of parsed.Parameters ?? []) {
				const name = String(p.Name ?? "").split("/").pop() ?? "";
				if (!name) continue;
				try {
					principals[name] = JSON.parse(p.Value);
				} catch {
					// malformed entry: skip, never fail the whole refresh
				}
			}
			next = parseDirectoryEntries(principals);
		}
	} catch (err: any) {
		// Keep the previous directory on refresh failure: a transient SSM or
		// file error must not lock the whole fleet out.
		logRejected("auth_refresh_failed", String(err?.message ?? err));
		return;
	}
	if (!next) return;
	const prev = tokenDirectory;
	tokenDirectory = next;

	// Revocation: sessions registered with a hash that vanished are evicted.
	for (const [projectName, p] of state.projects) {
		for (const [sid, entry] of [...p.agents]) {
			const th = entry.token_hash;
			if (!th) continue; // root/legacy sessions are not directory-managed
			if (prev.has(th) && !tokenDirectory.has(th)) {
				const w = p.streams.get(sid);
				if (w) {
					try { w.close(); } catch { /* noop */ }
					p.streams.delete(sid);
				}
				p.agents.delete(sid);
				nameIndexRemove(p, entry.name, sid);
				failDeliveredMail(p, projectName, sid, entry.name, "revoked");
				logUnregister(entry.name, "revoked");
				broadcast(p, "agent_left", {
					project: projectName, session_id: sid, name: entry.name, reason: "revoked",
				}, sid);
			}
		}
	}
}

// Session ownership (SIO-1609). Single-token mode: every caller is the shared
// principal. Root and any "*" principal act on every session; otherwise only
// the principal that registered a session may act on it. Inbox reads are NOT
// bound: the shared inbox is readable by every authenticated peer by design.
function ownsSession(auth: AuthResult, entry: RegistryEntry): boolean {
	if (!DIRECTORY_MODE) return true;
	if (auth.principal.names.includes("*")) return true;
	return entry.principal === auth.principal.principal;
}

// Project names become directory names under REG_ROOT; reject anything else.
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function validProject(v: unknown): v is string {
	return typeof v === "string" && PROJECT_RE.test(v);
}

function authenticate(req: Request): AuthResult | null {
	const h = req.headers.get("authorization") ?? "";
	if (!h.startsWith("Bearer ")) return null;
	const presented = h.slice(7);
	if (DIRECTORY_MODE) {
		const hash = sha256hex(presented);
		const hit = tokenDirectory.get(hash);
		if (hit) return { principal: hit, token_hash: hash };
		if (TOKEN && tokensEqual(presented, TOKEN)) return { principal: ROOT_PRINCIPAL, token_hash: null };
		return null;
	}
	if (!TOKEN) return null;
	return tokensEqual(presented, TOKEN) ? { principal: LEGACY_PRINCIPAL, token_hash: null } : null;
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function errorJson(error: string, status = 400, details?: any): Response {
	const body: ErrorResponse = { ok: false, error };
	if (details !== undefined) body.details = details;
	return json(body, status);
}

function unauthorized(): Response {
	return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
		status: 401,
		headers: {
			"content-type": "application/json",
			"www-authenticate": 'Bearer realm="coms-net"',
		},
	});
}

function projectDir(project: string): string {
	return path.join(REG_ROOT, "projects", project);
}

function ensureDirSync(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteSync(filePath: string, content: string, mode?: number): void {
	const dir = path.dirname(filePath);
	ensureDirSync(dir);
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, content);
	if (mode !== undefined) {
		try {
			fs.chmodSync(tmp, mode);
		} catch {
			// best-effort
		}
	}
	fs.renameSync(tmp, filePath);
}

export function sseFrame(event: string, data: unknown, id?: number): string {
	const lines = [`event: ${event}`];
	if (id !== undefined) lines.push(`id: ${id}`);
	lines.push(`data: ${JSON.stringify(data)}`);
	return lines.join("\n") + "\n\n";
}

export function resolveUniqueName(
	project: ProjectState,
	desiredName: string,
): string {
	const liveNames = new Set(
		[...project.agents.values()].map((a) => a.name),
	);
	if (!liveNames.has(desiredName)) return desiredName;
	let n = 2;
	while (liveNames.has(`${desiredName}${n}`)) n++;
	return `${desiredName}${n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mailbox (bun:sqlite write-through; the in-memory map stays the hot path)
// ─────────────────────────────────────────────────────────────────────────────

export class MailStore {
	private db: Database;
	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec(`CREATE TABLE IF NOT EXISTS messages (
			msg_id TEXT PRIMARY KEY,
			project TEXT NOT NULL,
			sender_session TEXT NOT NULL,
			sender_name TEXT NOT NULL DEFAULT '',
			sender_cwd TEXT NOT NULL DEFAULT '',
			target_session TEXT,
			target_name TEXT,
			prompt TEXT NOT NULL,
			conversation_id TEXT,
			response_schema TEXT,
			hops INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			mailbox INTEGER NOT NULL DEFAULT 0,
			response TEXT,
			error TEXT,
			created_at TEXT NOT NULL,
			delivered_at TEXT,
			completed_at TEXT,
			expires_at TEXT NOT NULL
		)`);
		// Migration for databases created before the inbox feature.
		const cols = this.db.query("PRAGMA table_info(messages)").all() as { name: string }[];
		if (!cols.some((c) => c.name === "mailbox")) {
			this.db.exec("ALTER TABLE messages ADD COLUMN mailbox INTEGER NOT NULL DEFAULT 0");
		}
	}
	upsert(m: ComsMessage): void {
		this.db.query(`INSERT INTO messages (msg_id, project, sender_session, sender_name, sender_cwd,
			target_session, target_name, prompt, conversation_id, response_schema, hops, status, mailbox,
			response, error, created_at, delivered_at, completed_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(msg_id) DO UPDATE SET target_session=excluded.target_session,
			target_name=excluded.target_name, status=excluded.status, response=excluded.response,
			error=excluded.error, delivered_at=excluded.delivered_at,
			completed_at=excluded.completed_at, expires_at=excluded.expires_at`).run(
			m.msg_id, m.project, m.sender_session, m.sender_name, m.sender_cwd,
			m.target_session, m.target_name, m.prompt, m.conversation_id,
			m.response_schema ? JSON.stringify(m.response_schema) : null, m.hops, m.status,
			m.mailbox ? 1 : 0,
			m.response == null ? null : JSON.stringify(m.response), m.error ?? null,
			m.created_at, m.delivered_at ?? null, m.completed_at ?? null, m.expires_at,
		);
	}
	remove(msg_id: string): void {
		this.db.query("DELETE FROM messages WHERE msg_id = ?").run(msg_id);
	}
	loadNonTerminal(): ComsMessage[] {
		const rows = this.db.query(
			"SELECT * FROM messages WHERE status IN ('queued','delivered') ORDER BY created_at ASC",
		).all() as any[];
		return rows.map((r) => ({
			msg_id: r.msg_id,
			project: r.project,
			sender_session: r.sender_session,
			sender_name: r.sender_name,
			sender_cwd: r.sender_cwd,
			target_session: r.target_session,
			target_name: r.target_name,
			prompt: r.prompt,
			conversation_id: r.conversation_id,
			response_schema: r.response_schema ? JSON.parse(r.response_schema) : null,
			hops: r.hops,
			status: r.status as MessageStatus,
			mailbox: r.mailbox === 1,
			response: r.response == null ? null : JSON.parse(r.response),
			error: r.error,
			created_at: r.created_at,
			...(r.delivered_at ? { delivered_at: r.delivered_at } : {}),
			...(r.completed_at ? { completed_at: r.completed_at } : {}),
			expires_at: r.expires_at,
		}));
	}
	// The durable inbox: mailbox-class messages addressed to a name, ascending
	// by msg_id (ULIDs sort by creation time). Without `since`, the newest
	// `limit` messages; with it, only newer ones.
	inbox(
		targetName: string,
		limit: number,
		since?: string,
	): {
		msg_id: string;
		sender_name: string;
		target_name: string | null;
		prompt: string;
		status: string;
		error: string | null;
		created_at: string;
		delivered_at: string | null;
		completed_at: string | null;
	}[] {
		const cols =
			"msg_id, sender_name, target_name, prompt, status, error, created_at, delivered_at, completed_at";
		if (since) {
			return this.db.query(
				`SELECT ${cols} FROM messages WHERE mailbox = 1 AND target_name = ? AND msg_id > ?
				ORDER BY msg_id ASC LIMIT ?`,
			).all(targetName, since, limit) as any[];
		}
		return this.db.query(
			`SELECT * FROM (SELECT ${cols} FROM messages WHERE mailbox = 1 AND target_name = ?
			ORDER BY msg_id DESC LIMIT ?) ORDER BY msg_id ASC`,
		).all(targetName, limit) as any[];
	}

	// Retention horizon for the inbox: terminal mailbox rows live until their
	// expiry. Non-terminal rows belong to the live sweep, which marks them
	// expired in memory first.
	purgeExpired(): void {
		this.db.query(
			"DELETE FROM messages WHERE mailbox = 1 AND status IN ('complete','error','timeout') AND expires_at < ?",
		).run(new Date().toISOString());
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			// noop
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// State (module scope, single instance shared by router & loops)
// ─────────────────────────────────────────────────────────────────────────────

const state: ServerState = {
	server_id: ulid(),
	started_at: nowIso(),
	projects: new Map<string, ProjectState>(),
};

const mailStores = new Map<string, MailStore>();

function mailFor(project: string): MailStore {
	let s = mailStores.get(project);
	if (!s) {
		s = new MailStore(path.join(projectDir(project), "messages.db"));
		mailStores.set(project, s);
	}
	return s;
}

function getOrCreateProject(name: string): ProjectState {
	let p = state.projects.get(name);
	if (!p) {
		p = {
			agents: new Map(),
			nameIndex: new Map(),
			messages: new Map(),
			streams: new Map(),
			awaiters: new Map(),
		};
		state.projects.set(name, p);
	}
	return p;
}

function nameIndexAdd(p: ProjectState, name: string, sessionId: string): void {
	let bag = p.nameIndex.get(name);
	if (!bag) {
		bag = new Set();
		p.nameIndex.set(name, bag);
	}
	bag.add(sessionId);
}

function nameIndexRemove(
	p: ProjectState,
	name: string,
	sessionId: string,
): void {
	const bag = p.nameIndex.get(name);
	if (!bag) return;
	bag.delete(sessionId);
	if (bag.size === 0) p.nameIndex.delete(name);
}

function entryToCard(e: RegistryEntry): AgentCard {
	const {
		session_id,
		name,
		purpose,
		model,
		provider,
		color,
		cwd,
		project,
		explicit,
		started_at,
		context_used_pct,
		queue_depth,
		status,
	} = e;
	return {
		session_id,
		name,
		purpose,
		model,
		provider,
		color,
		cwd,
		project,
		explicit,
		started_at,
		context_used_pct,
		queue_depth,
		status,
	};
}

function broadcast(
	p: ProjectState,
	event: string,
	data: unknown,
	excludeSession?: string,
): void {
	for (const [sid, w] of p.streams) {
		if (excludeSession && sid === excludeSession) continue;
		const id = ++w.lastId;
		try {
			w.enqueue(sseFrame(event, data, id));
		} catch {
			// stream is dead; the abort handler will reap it
		}
	}
}

function sendToStream(
	p: ProjectState,
	sessionId: string,
	event: string,
	data: unknown,
): void {
	const w = p.streams.get(sessionId);
	if (!w) return;
	const id = ++w.lastId;
	try {
		w.enqueue(sseFrame(event, data, id));
	} catch {
		// dead; abort handler will reap
	}
}

function flushQueuedMail(p: ProjectState, projectName: string, sessionId: string): void {
	const entry = p.agents.get(sessionId);
	if (!entry) return;
	const mail = mailFor(projectName);
	// Claim name-addressed mail for this session.
	for (const m of p.messages.values()) {
		if (m.status === "queued" && m.target_session === null && m.target_name === entry.name) {
			m.target_session = sessionId;
			mail.upsert(m);
		}
	}
	const pendingList = [...p.messages.values()]
		.filter((m) => m.status === "queued" && m.target_session === sessionId)
		.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
	for (const m of pendingList) {
		sendToStream(p, sessionId, "prompt", {
			msg_id: m.msg_id,
			project: projectName,
			sender: { session_id: m.sender_session, name: m.sender_name, cwd: m.sender_cwd },
			prompt: m.prompt,
			conversation_id: m.conversation_id,
			response_schema: m.response_schema,
			hops: m.hops,
			mailbox: m.mailbox,
		});
		m.status = "delivered";
		m.delivered_at = nowIso();
		mail.upsert(m);
		sendToStream(p, m.sender_session, "message_status", {
			msg_id: m.msg_id,
			status: "delivered",
		});
		logMessageSend(m.sender_name, entry.name, m.msg_id, m.prompt, m.hops, true);
	}
}

function recoverMail(): void {
	const projectsRoot = path.join(REG_ROOT, "projects");
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(projectsRoot);
	} catch {
		return; // no prior state
	}
	for (const name of entries) {
		const dbPath = path.join(projectsRoot, name, "messages.db");
		if (!fs.existsSync(dbPath)) continue;
		const p = getOrCreateProject(name);
		for (const m of mailFor(name).loadNonTerminal()) {
			// Sessions do not survive a restart; delivered-but-unanswered mail is
			// re-queued (at-least-once) so the next session under the name gets it.
			if (m.status === "delivered" || m.target_session !== null) {
				m.status = "queued";
				m.target_session = null;
				delete m.delivered_at;
				mailFor(name).upsert(m);
			}
			p.messages.set(m.msg_id, m);
		}
	}
}

function releaseAwaiters(p: ProjectState, msg_id: string): void {
	const set = p.awaiters.get(msg_id);
	if (!set) return;
	const message = p.messages.get(msg_id);
	for (const a of set) {
		if (a.timer) clearTimeout(a.timer);
		try {
			if (message) a.resolve(message);
		} catch {
			// noop
		}
	}
	p.awaiters.delete(msg_id);
}

// SIO-1578: an in-flight turn does not survive its agent's death, so any
// message delivered to a departing session that has no reply yet is failed
// terminally and the sender is told right away -- otherwise its await hangs
// until timeout. Queued (undelivered) mail keeps store-and-forward semantics.
function failDeliveredMail(
	p: ProjectState,
	projectName: string,
	sessionId: string,
	targetName: string,
	reason: string,
): void {
	for (const m of p.messages.values()) {
		if (m.status !== "delivered" || m.target_session !== sessionId) continue;
		m.status = "error";
		m.error = "target_died";
		m.completed_at = nowIso();
		mailFor(projectName).upsert(m);
		sendToStream(p, m.sender_session, "response", {
			msg_id: m.msg_id,
			project: projectName,
			responder: { session_id: sessionId, name: targetName },
			response: null,
			error: "target_died",
			status: "error",
			reason,
		});
		sendToStream(p, m.sender_session, "message_status", {
			msg_id: m.msg_id,
			status: "error",
		});
		releaseAwaiters(p, m.msg_id);
		logTargetDied(m.msg_id, targetName, reason);
	}
}

function inboxDepthFor(p: ProjectState, targetSession: string): number {
	let n = 0;
	for (const m of p.messages.values()) {
		if (m.target_session !== targetSession) continue;
		if (m.status === "queued" || m.status === "delivered") n++;
	}
	return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleHealth(_req: Request): Promise<Response> {
	return json({
		ok: true,
		version: 1,
		server_id: state.server_id,
		started_at: state.started_at,
	});
}

async function handleRegister(req: Request, auth: AuthResult | null): Promise<Response> {
	let body: RegisterRequest;
	try {
		body = (await req.json()) as RegisterRequest;
	} catch {
		return errorJson("invalid_json", 400);
	}
	if (
		!body ||
		typeof body !== "object" ||
		typeof body.session_id !== "string" ||
		typeof body.project !== "string" ||
		typeof body.name !== "string"
	) {
		return errorJson("invalid_request", 400);
	}
	const principal = auth?.principal ?? LEGACY_PRINCIPAL;
	const projectName = body.project || "default";
	if (!validProject(projectName)) return errorJson("invalid_project", 400);
	const p = getOrCreateProject(projectName);
	const desiredName = body.name && body.name.length > 0 ? body.name : "agent";

	// Directory mode: a principal may only register names on its list, and a
	// name held by another live session is a conflict, never auto-suffixed --
	// silently becoming "ops2" would defeat the binding.
	const strictNames = DIRECTORY_MODE && !principal.names.includes("*");
	if (strictNames && !nameAllowed(principal, desiredName)) {
		logRejected("name_not_allowed", `${principal.principal} → "${desiredName}"`);
		return errorJson("name_not_allowed", 403, { name: desiredName, principal: principal.principal });
	}

	let resolvedName = desiredName;
	const existing = p.agents.get(body.session_id);
	const isReregister = !!existing;
	if (existing) {
		// upsert: keep their existing name unless they ask for a different one
		if (body.name && body.name !== existing.name) {
			resolvedName = resolveUniqueName(p, desiredName);
			if (strictNames && resolvedName !== desiredName) {
				logRejected("name_taken", `${principal.principal} → "${desiredName}"`);
				return errorJson("name_taken", 409, { name: desiredName });
			}
		} else {
			resolvedName = existing.name;
		}
	} else {
		resolvedName = resolveUniqueName(p, desiredName);
		if (strictNames && resolvedName !== desiredName) {
			logRejected("name_taken", `${principal.principal} → "${desiredName}"`);
			return errorJson("name_taken", 409, { name: desiredName });
		}
	}

	const card: AgentCard = {
		session_id: body.session_id,
		name: resolvedName,
		purpose: body.purpose ?? "",
		model: body.model ?? "unknown",
		provider: body.provider,
		color: body.color ?? "#888888",
		cwd: body.cwd ?? "",
		project: projectName,
		explicit: body.explicit === true,
		started_at: existing?.started_at ?? nowIso(),
		context_used_pct: existing?.context_used_pct ?? 0,
		queue_depth: existing?.queue_depth ?? 0,
		status: "online",
	};
	const entry: RegistryEntry = {
		...card,
		registered_at: existing?.registered_at ?? nowIso(),
		last_seen_at: nowIso(),
		...(auth?.token_hash ? { token_hash: auth.token_hash } : {}),
		principal: principal.principal,
	};

	if (existing && existing.name !== entry.name) {
		nameIndexRemove(p, existing.name, body.session_id);
	}
	p.agents.set(body.session_id, entry);
	nameIndexAdd(p, entry.name, body.session_id);

	logRegister(entry.name, projectName, body.session_id, isReregister, DIRECTORY_MODE ? principal.principal : undefined);

	// Emit agent_joined to OTHER streams (do not echo to a stream that may not
	// exist yet — the registering client opens SSE next).
	broadcast(
		p,
		"agent_joined",
		{ project: projectName, agent: entryToCard(entry) },
		body.session_id,
	);

	const sse_url = `/v1/events?project=${encodeURIComponent(projectName)}&session_id=${encodeURIComponent(body.session_id)}`;
	const resp: RegisterResponse = {
		ok: true,
		agent: entryToCard(entry),
		heartbeat_interval_ms: HEARTBEAT_MS,
		sse_url,
	};
	return json(resp);
}

function handleEvents(req: Request, url: URL, auth: AuthResult): Response {
	const projectName = url.searchParams.get("project") ?? "default";
	if (!validProject(projectName)) return errorJson("invalid_project", 400);
	const session_id = url.searchParams.get("session_id") ?? "";
	if (!session_id) return errorJson("missing_session_id", 400);
	const p = getOrCreateProject(projectName);
	const entry = p.agents.get(session_id);
	if (!entry) return errorJson("agent_not_found", 404);
	if (!ownsSession(auth, entry)) return errorJson("not_owner", 403);

	const enc = new TextEncoder();
	let writer: SseWriter | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			writer = {
				session_id,
				lastId: 0,
				enqueue(frame: string) {
					if (closed) return;
					try {
						controller.enqueue(enc.encode(frame));
					} catch {
						closed = true;
					}
				},
				close() {
					if (closed) return;
					closed = true;
					try {
						controller.close();
					} catch {
						// already closed
					}
				},
			};
			// Replace possibly-stale stream entry
			const old = p.streams.get(session_id);
			if (old && old !== writer) {
				try {
					old.close();
				} catch {
					// noop
				}
			}
			p.streams.set(session_id, writer);
			logSseOpen(entry.name, p.streams.size);

			// hello
			const helloId = ++writer.lastId;
			try {
				controller.enqueue(
					enc.encode(
						sseFrame(
							"hello",
							{ server_time: nowIso(), server_id: state.server_id },
							helloId,
						),
					),
				);
			} catch {
				closed = true;
			}

			// pool_snapshot
			const agents: AgentCard[] = [];
			for (const a of p.agents.values()) {
				if (a.session_id === session_id) continue;
				if (a.explicit) continue;
				agents.push(entryToCard(a));
			}
			const snapId = ++writer.lastId;
			try {
				controller.enqueue(
					enc.encode(
						sseFrame(
							"pool_snapshot",
							{ project: projectName, agents },
							snapId,
						),
					),
				);
			} catch {
				closed = true;
			}

			// Mailbox: flush queued messages for this session, oldest first.
			flushQueuedMail(p, projectName, session_id);

			// abort handler
			const onAbort = () => {
				if (closed) return;
				closed = true;
				const cur = p.streams.get(session_id);
				if (cur === writer) p.streams.delete(session_id);
				try {
					controller.close();
				} catch {
					// noop
				}
				const left = p.agents.get(session_id);
				if (left) {
					logSseClose(left.name, "connection_closed");
					broadcast(
						p,
						"agent_left",
						{
							project: projectName,
							session_id,
							name: left.name,
							reason: "connection_closed",
						},
						session_id,
					);
				}
			};
			try {
				req.signal.addEventListener("abort", onAbort);
			} catch {
				// noop
			}
		},
		cancel() {
			const cur = p.streams.get(session_id);
			if (cur === writer) p.streams.delete(session_id);
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		},
	});
}

async function handleHeartbeat(
	req: Request,
	sessionId: string,
	auth: AuthResult,
): Promise<Response> {
	let body: HeartbeatRequest;
	try {
		body = (await req.json()) as HeartbeatRequest;
	} catch {
		return errorJson("invalid_json", 400);
	}
	const projectName = body?.project ?? "default";
	if (!validProject(projectName)) return errorJson("invalid_project", 400);
	const p = state.projects.get(projectName);
	if (!p) return errorJson("agent_not_found", 404);
	const entry = p.agents.get(sessionId);
	if (!entry) return errorJson("agent_not_found", 404);
	if (!ownsSession(auth, entry)) return errorJson("not_owner", 403);

	const before: Partial<AgentCard> = {
		context_used_pct: entry.context_used_pct,
		queue_depth: entry.queue_depth,
		model: entry.model,
		status: entry.status,
	};
	if (typeof body.context_used_pct === "number")
		entry.context_used_pct = body.context_used_pct;
	if (typeof body.queue_depth === "number")
		entry.queue_depth = body.queue_depth;
	if (typeof body.model === "string") entry.model = body.model;
	if (
		body.status === "online" ||
		body.status === "stale" ||
		body.status === "offline"
	) {
		entry.status = body.status;
	} else {
		entry.status = "online";
	}
	entry.last_seen_at = nowIso();

	logHeartbeat(entry.name, entry.context_used_pct, entry.queue_depth);

	const changed =
		before.context_used_pct !== entry.context_used_pct ||
		before.queue_depth !== entry.queue_depth ||
		before.model !== entry.model ||
		before.status !== entry.status;
	if (changed) {
		broadcast(
			p,
			"agent_updated",
			{
				project: projectName,
				agent: {
					session_id: entry.session_id,
					name: entry.name,
					context_used_pct: entry.context_used_pct,
					queue_depth: entry.queue_depth,
					model: entry.model,
					status: entry.status,
				},
			},
			sessionId,
		);
	}
	return json({ ok: true });
}

function handleListAgents(_req: Request, url: URL): Response {
	const projectName = url.searchParams.get("project") ?? "default";
	const includeExplicit =
		(url.searchParams.get("include_explicit") ?? "false").toLowerCase() ===
		"true";
	const p = state.projects.get(projectName);
	const out: AgentCard[] = [];
	if (p) {
		for (const e of p.agents.values()) {
			if (!includeExplicit && e.explicit) continue;
			out.push(entryToCard(e));
		}
	}
	return json({ agents: out });
}

async function handleSendMessage(req: Request, auth: AuthResult): Promise<Response> {
	let body: SendRequest;
	try {
		body = (await req.json()) as SendRequest;
	} catch {
		return errorJson("invalid_json", 400);
	}
	if (
		!body ||
		typeof body !== "object" ||
		typeof body.sender_session !== "string" ||
		typeof body.prompt !== "string"
	) {
		return errorJson("invalid_request", 400);
	}
	const projectName = body.project ?? "default";
	if (!validProject(projectName)) return errorJson("invalid_project", 400);
	const p = state.projects.get(projectName);
	if (!p) return errorJson("agent_not_found", 404);

	const sender = p.agents.get(body.sender_session);
	if (!sender) return errorJson("sender_not_registered", 404);
	if (!ownsSession(auth, sender)) return errorJson("not_owner", 403);

	const hops = typeof body.hops === "number" ? body.hops : 0;
	if (hops >= MAX_HOPS) {
		logRejected("hop_limit", `${sender.name} hops=${hops} max=${MAX_HOPS}`);
		return errorJson("hop_limit_exceeded", 409, { hops, max_hops: MAX_HOPS });
	}

	// Mailbox TTL: beyond the default the send survives an offline recipient.
	const requestedTtl =
		typeof body.ttl_ms === "number" && body.ttl_ms > 0
			? Math.min(body.ttl_ms, MAX_TTL_MS)
			: MESSAGE_TTL_MS;
	const isMailbox = requestedTtl > MESSAGE_TTL_MS;

	// Resolve target.
	let target: RegistryEntry | undefined;
	if (body.target_session && typeof body.target_session === "string") {
		target = p.agents.get(body.target_session);
		if (!target) {
			logRejected("target_not_found", `${sender.name} → ${body.target_session.slice(-6)}`);
			return errorJson("target_not_found", 404);
		}
	} else {
		const desired = (body.target ?? "").trim();
		if (!desired) return errorJson("missing_target", 400);
		// Direct session_id match first.
		const directSid = p.agents.get(desired);
		if (directSid) {
			target = directSid;
		} else {
			const bag = p.nameIndex.get(desired);
			if (!bag || bag.size === 0) {
				if (isMailbox) {
					// Store-and-forward: queue by name for the next session
					// registering under it. target stays unresolved.
					const msg: ComsMessage = {
						msg_id: ulid(),
						project: projectName,
						sender_session: body.sender_session,
						sender_name: sender.name,
						sender_cwd: sender.cwd,
						target_session: null,
						target_name: desired,
						prompt: body.prompt,
						conversation_id:
							body.conversation_id && typeof body.conversation_id === "string"
								? body.conversation_id
								: null,
						response_schema:
							body.response_schema && typeof body.response_schema === "object"
								? body.response_schema
								: null,
						hops,
						status: "queued",
						mailbox: isMailbox,
						response: null,
						error: null,
						created_at: nowIso(),
						expires_at: new Date(Date.now() + requestedTtl).toISOString(),
					};
					p.messages.set(msg.msg_id, msg);
					mailFor(projectName).upsert(msg);
					sendToStream(p, body.sender_session, "message_status", {
						msg_id: msg.msg_id,
						status: "queued",
					});
					logMessageSend(sender.name, `${desired}(offline)`, msg.msg_id, msg.prompt, hops, false);
					const resp: SendResponse = {
						ok: true,
						msg_id: msg.msg_id,
						status: "queued",
						target_session: null,
					};
					return json(resp);
				}
				logRejected("target_not_found", `${sender.name} → "${desired}"`);
				return errorJson("target_not_found", 404, { target: desired });
			}
			if (bag.size > 1) {
				logRejected("ambiguous", `${sender.name} → "${desired}" matches ${bag.size}`);
				return errorJson("ambiguous_target", 409, {
					target: desired,
					candidates: [...bag],
				});
			}
			const onlySid = [...bag][0];
			target = p.agents.get(onlySid);
			if (!target) return errorJson("target_not_found", 404);
		}
	}

	// Inbox cap.
	const depth = inboxDepthFor(p, target.session_id);
	if (depth >= MAX_INBOX) {
		logRejected("inbox_full", `${sender.name} → ${target.name} depth=${depth}`);
		return errorJson("inbox_full", 429, { depth, max_inbox: MAX_INBOX });
	}

	const created = nowIso();
	const expires = new Date(Date.now() + requestedTtl).toISOString();
	const msg: ComsMessage = {
		msg_id: ulid(),
		project: projectName,
		sender_session: body.sender_session,
		sender_name: sender.name,
		sender_cwd: sender.cwd,
		target_session: target.session_id,
		target_name: target.name,
		prompt: body.prompt,
		conversation_id:
			body.conversation_id && typeof body.conversation_id === "string"
				? body.conversation_id
				: null,
		response_schema:
			body.response_schema && typeof body.response_schema === "object"
				? body.response_schema
				: null,
		hops,
		status: "queued",
		mailbox: isMailbox,
		response: null,
		error: null,
		created_at: created,
		expires_at: expires,
	};
	p.messages.set(msg.msg_id, msg);
	mailFor(projectName).upsert(msg);

	// Notify sender: queued
	sendToStream(p, body.sender_session, "message_status", {
		msg_id: msg.msg_id,
		status: "queued",
	});

	// Emit prompt to target if its stream is open.
	const targetWriter = p.streams.get(target.session_id);
	if (targetWriter) {
		sendToStream(p, target.session_id, "prompt", {
			msg_id: msg.msg_id,
			project: projectName,
			sender: {
				session_id: sender.session_id,
				name: sender.name,
				cwd: sender.cwd,
			},
			prompt: msg.prompt,
			conversation_id: msg.conversation_id,
			response_schema: msg.response_schema,
			hops: msg.hops,
			mailbox: msg.mailbox,
		});
		msg.status = "delivered";
		msg.delivered_at = nowIso();
		mailFor(projectName).upsert(msg);
		// Notify sender: delivered
		sendToStream(p, body.sender_session, "message_status", {
			msg_id: msg.msg_id,
			status: "delivered",
		});
	}

	logMessageSend(
		sender.name,
		target.name,
		msg.msg_id,
		msg.prompt,
		hops,
		msg.status === "delivered",
	);

	const resp: SendResponse = {
		ok: true,
		msg_id: msg.msg_id,
		status: msg.status,
		target_session: target.session_id,
	};
	return json(resp);
}

// The durable inbox: read-many, non-destructive, so every operator sees the
// same messages on demand. Reads sqlite directly -- retained terminal rows are
// no longer in the in-memory map.
function handleInbox(_req: Request, url: URL): Response {
	const projectName = url.searchParams.get("project") ?? "default";
	if (!validProject(projectName)) return errorJson("invalid_project", 400);
	const name = (url.searchParams.get("name") ?? "").trim();
	if (!name) return errorJson("missing_name", 400);
	// Reads are open to every authenticated peer (shared inbox), but an unknown
	// project must not create a store or a directory on disk.
	if (
		!state.projects.has(projectName) &&
		!mailStores.has(projectName) &&
		!fs.existsSync(path.join(projectDir(projectName), "messages.db"))
	) {
		return json({ ok: true, name, messages: [] });
	}
	const requested = Number(url.searchParams.get("limit") ?? 20);
	const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 100) : 20;
	const since = url.searchParams.get("since") ?? undefined;
	const messages = mailFor(projectName).inbox(name, limit, since);
	return json({ ok: true, name, messages });
}

function handleGetMessage(_req: Request, msg_id: string): Response {
	for (const p of state.projects.values()) {
		const m = p.messages.get(msg_id);
		if (m) {
			return json({
				msg_id: m.msg_id,
				status: m.status,
				response: m.response ?? null,
				error: m.error ?? null,
			});
		}
	}
	return errorJson("message_not_found", 404);
}

function handleAwaitMessage(req: Request, url: URL, msg_id: string): Response {
	let project: ProjectState | undefined;
	let msg: ComsMessage | undefined;
	for (const p of state.projects.values()) {
		const m = p.messages.get(msg_id);
		if (m) {
			project = p;
			msg = m;
			break;
		}
	}
	if (!project || !msg) {
		return new Response(
			JSON.stringify({ ok: false, error: "message_not_found" }),
			{ status: 404, headers: { "content-type": "application/json" } },
		);
	}
	// Already terminal? Resolve immediately.
	if (
		msg.status === "complete" ||
		msg.status === "error" ||
		msg.status === "timeout"
	) {
		return json({
			msg_id: msg.msg_id,
			status: msg.status,
			response: msg.response ?? null,
			error: msg.error ?? null,
		});
	}

	const requested = Number(url.searchParams.get("timeout_ms") ?? "");
	let timeout_ms =
		Number.isFinite(requested) && requested > 0
			? requested
			: DEFAULT_AWAIT_TIMEOUT_MS;
	// Clamp to TTL.
	if (timeout_ms > MESSAGE_TTL_MS) timeout_ms = MESSAGE_TTL_MS;

	const proj = project; // for closure
	const id = msg_id;

	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				const enc = new TextEncoder();
				let done = false;

				const set = proj.awaiters.get(id) ?? new Set<Awaiter>();
				proj.awaiters.set(id, set);

				const finalize = (payload: any, status = 200) => {
					if (done) return;
					done = true;
					try {
						controller.enqueue(enc.encode(JSON.stringify(payload)));
						controller.close();
					} catch {
						// already closed
					}
					void status;
				};

				const awaiter: Awaiter = {
					resolve: (m: ComsMessage) => {
						finalize({
							msg_id: m.msg_id,
							status: m.status,
							response: m.response ?? null,
							error: m.error ?? null,
						});
					},
					timer: null,
				};

				awaiter.timer = setTimeout(() => {
					const cur = proj.awaiters.get(id);
					if (cur) {
						cur.delete(awaiter);
						if (cur.size === 0) proj.awaiters.delete(id);
					}
					finalize({
						msg_id: id,
						status: "timeout",
						response: null,
						error: "timeout",
					});
				}, timeout_ms);
				try {
					(awaiter.timer as any).unref?.();
				} catch {
					// noop
				}

				set.add(awaiter);

				// Connection abort: clean the awaiter.
				try {
					req.signal.addEventListener("abort", () => {
						if (done) return;
						const cur = proj.awaiters.get(id);
						if (cur) {
							cur.delete(awaiter);
							if (cur.size === 0) proj.awaiters.delete(id);
						}
						if (awaiter.timer) clearTimeout(awaiter.timer);
						done = true;
						try {
							controller.close();
						} catch {
							// noop
						}
					});
				} catch {
					// noop
				}
			},
		}),
		{
			status: 200,
			headers: { "content-type": "application/json" },
		},
	);
}

async function handleSubmitResponse(
	req: Request,
	msg_id: string,
	auth: AuthResult,
): Promise<Response> {
	let body: ResponseSubmitRequest;
	try {
		body = (await req.json()) as ResponseSubmitRequest;
	} catch {
		return errorJson("invalid_json", 400);
	}
	if (
		!body ||
		typeof body !== "object" ||
		typeof body.responder_session !== "string"
	) {
		return errorJson("invalid_request", 400);
	}
	let project: ProjectState | undefined;
	let msg: ComsMessage | undefined;
	for (const p of state.projects.values()) {
		const m = p.messages.get(msg_id);
		if (m) {
			project = p;
			msg = m;
			break;
		}
	}
	if (!project || !msg) return errorJson("message_not_found", 404);
	if (body.responder_session !== msg.target_session) {
		return errorJson("not_target", 403);
	}
	// Directory mode: only the principal holding the target session may answer.
	const responder = project.agents.get(body.responder_session);
	if (DIRECTORY_MODE && (!responder || !ownsSession(auth, responder))) {
		return errorJson("not_owner", 403);
	}
	if (
		msg.status === "complete" ||
		msg.status === "error" ||
		msg.status === "timeout"
	) {
		return errorJson("already_terminal", 409, { status: msg.status });
	}

	const isError = body.error !== null && body.error !== undefined;
	msg.status = isError ? "error" : "complete";
	msg.response = body.response ?? null;
	msg.error = isError ? String(body.error) : null;
	msg.completed_at = nowIso();
	mailFor(msg.project).upsert(msg);

	const responderName = responder?.name ?? "unknown";

	// Notify sender (if its stream is open).
	sendToStream(project, msg.sender_session, "response", {
		msg_id: msg.msg_id,
		project: msg.project,
		responder: { session_id: body.responder_session, name: responderName },
		response: msg.response,
		error: msg.error,
		status: msg.status,
	});
	// Also push a final message_status for completeness.
	sendToStream(project, msg.sender_session, "message_status", {
		msg_id: msg.msg_id,
		status: msg.status,
	});

	releaseAwaiters(project, msg_id);

	const senderName = project.agents.get(msg.sender_session)?.name ?? "(gone)";
	const responseSize =
		typeof msg.response === "string"
			? msg.response.length
			: msg.response
				? JSON.stringify(msg.response).length
				: 0;
	logResponse(responderName, senderName, msg.msg_id, isError, msg.error, responseSize);

	return json({ ok: true });
}

function handleDeleteAgent(_req: Request, url: URL, sessionId: string, auth: AuthResult): Response {
	const projectName = url.searchParams.get("project") ?? "default";
	if (!validProject(projectName)) return errorJson("invalid_project", 400);
	const p = state.projects.get(projectName);
	if (!p) return errorJson("agent_not_found", 404);
	const entry = p.agents.get(sessionId);
	if (!entry) return errorJson("agent_not_found", 404);
	if (!ownsSession(auth, entry)) return errorJson("not_owner", 403);

	// Close stream first; the abort handler may also fire.
	const stream = p.streams.get(sessionId);
	if (stream) {
		try {
			stream.close();
		} catch {
			// noop
		}
		p.streams.delete(sessionId);
	}

	p.agents.delete(sessionId);
	nameIndexRemove(p, entry.name, sessionId);
	failDeliveredMail(p, projectName, sessionId, entry.name, "shutdown");

	logUnregister(entry.name, "shutdown");

	broadcast(
		p,
		"agent_left",
		{
			project: projectName,
			session_id: sessionId,
			name: entry.name,
			reason: "shutdown",
		},
		sessionId,
	);

	return json({ ok: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

async function router(req: Request): Promise<Response> {
	let url: URL;
	try {
		url = new URL(req.url);
	} catch {
		return errorJson("invalid_url", 400);
	}
	const method = req.method.toUpperCase();
	const pathname = url.pathname;

	// 1. /health (no auth)
	if (pathname === "/health" && method === "GET") {
		return handleHealth(req);
	}

	// All /v1/* require bearer auth.
	let auth: AuthResult | null = null;
	if (pathname.startsWith("/v1/")) {
		auth = authenticate(req);
		if (!auth) return unauthorized();
	} else {
		// Unknown non-/v1 route.
		return errorJson("not_found", 404);
	}

	// 2. POST /v1/agents/register
	if (pathname === "/v1/agents/register" && method === "POST") {
		return handleRegister(req, auth);
	}

	// 3. GET /v1/events
	if (pathname === "/v1/events" && method === "GET") {
		return handleEvents(req, url, auth);
	}

	// 5. GET /v1/agents
	if (pathname === "/v1/agents" && method === "GET") {
		return handleListAgents(req, url);
	}

	// 6. POST /v1/messages
	if (pathname === "/v1/messages" && method === "POST") {
		return handleSendMessage(req, auth);
	}

	// 7. GET /v1/mailbox (durable inbox, read-many)
	if (pathname === "/v1/mailbox" && method === "GET") {
		return handleInbox(req, url);
	}

	// /v1/agents/:session_id/heartbeat (POST) and DELETE /v1/agents/:session_id
	const agentMatch = pathname.match(
		/^\/v1\/agents\/([^/]+)(?:\/(heartbeat))?$/,
	);
	if (agentMatch) {
		const sessionId = decodeURIComponent(agentMatch[1]);
		const tail = agentMatch[2];
		if (tail === "heartbeat" && method === "POST") {
			return handleHeartbeat(req, sessionId, auth);
		}
		if (!tail && method === "DELETE") {
			return handleDeleteAgent(req, url, sessionId, auth);
		}
		return errorJson("method_not_allowed", 405);
	}

	// /v1/messages/:id, /v1/messages/:id/await, /v1/messages/:id/response
	const msgMatch = pathname.match(
		/^\/v1\/messages\/([^/]+)(?:\/(await|response))?$/,
	);
	if (msgMatch) {
		const msg_id = decodeURIComponent(msgMatch[1]);
		const tail = msgMatch[2];
		if (!tail && method === "GET") {
			return handleGetMessage(req, msg_id);
		}
		if (tail === "await" && method === "GET") {
			return handleAwaitMessage(req, url, msg_id);
		}
		if (tail === "response" && method === "POST") {
			return handleSubmitResponse(req, msg_id, auth);
		}
		return errorJson("method_not_allowed", 405);
	}

	return errorJson("not_found", 404);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup loops (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

let staleScanTimer: ReturnType<typeof setInterval> | null = null;
let ttlScanTimer: ReturnType<typeof setInterval> | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

function staleScanTick(): void {
	const now = Date.now();
	for (const [projectName, p] of state.projects) {
		for (const [sid, entry] of p.agents) {
			const last = Date.parse(entry.last_seen_at);
			if (Number.isNaN(last)) continue;
			const dt = now - last;
			if (dt > OFFLINE_AFTER_MS) {
				// Remove agent, close stream, emit agent_left.
				p.agents.delete(sid);
				nameIndexRemove(p, entry.name, sid);
				const stream = p.streams.get(sid);
				if (stream) {
					try {
						stream.close();
					} catch {
						// noop
					}
					p.streams.delete(sid);
				}
				failDeliveredMail(p, projectName, sid, entry.name, "stale");
				logOffline(entry.name);
				broadcast(
					p,
					"agent_left",
					{
						project: projectName,
						session_id: sid,
						name: entry.name,
						reason: "stale",
					},
					sid,
				);
			} else if (dt > STALE_AFTER_MS && entry.status !== "stale") {
				entry.status = "stale";
				logStale(entry.name, Math.round(dt / 1000));
				broadcast(
					p,
					"agent_stale",
					{
						project: projectName,
						session_id: sid,
						name: entry.name,
						last_seen_at: entry.last_seen_at,
					},
					sid,
				);
			}
		}
	}
}

function ttlScanTick(): void {
	const now = Date.now();
	for (const [projectName, p] of state.projects) {
		for (const [id, m] of [...p.messages]) {
			const expires = Date.parse(m.expires_at);
			const completedAt = m.completed_at ? Date.parse(m.completed_at) : 0;
			if (
				m.status === "queued" ||
				m.status === "delivered"
			) {
				if (Number.isFinite(expires) && now > expires) {
					m.status = "error";
					m.error = "expired";
					m.completed_at = nowIso();
					releaseAwaiters(p, id);
					logExpired(id);
					p.messages.delete(id);
					mailFor(projectName).remove(id);
				}
			} else if (m.status === "complete" || m.status === "error") {
				if (
					Number.isFinite(completedAt) &&
					now - completedAt > MESSAGE_TTL_MS
				) {
					p.messages.delete(id);
					// Mailbox rows stay on disk as inbox history until expiry.
					if (!m.mailbox) mailFor(projectName).remove(id);
				}
			} else if (m.status === "timeout") {
				if (Number.isFinite(expires) && now > expires) {
					p.messages.delete(id);
					mailFor(projectName).remove(id);
				}
			}
		}
		mailFor(projectName).purgeExpired();
	}
}

function keepaliveTick(): void {
	const ts = nowIso();
	const frame = `: ping ${ts}\n\n`;
	for (const p of state.projects.values()) {
		for (const [, w] of p.streams) {
			try {
				w.enqueue(frame);
			} catch {
				// dead; abort handler will reap
			}
		}
	}
}

let authRefreshTimer: ReturnType<typeof setInterval> | null = null;

function startLoops(): void {
	staleScanTimer = setInterval(staleScanTick, STALE_SCAN_INTERVAL_MS);
	ttlScanTimer = setInterval(ttlScanTick, TTL_SCAN_INTERVAL_MS);
	keepaliveTimer = setInterval(keepaliveTick, SSE_KEEPALIVE_MS);
	if (DIRECTORY_MODE) {
		authRefreshTimer = setInterval(() => {
			void refreshTokenDirectory();
		}, AUTH_REFRESH_MS);
		try {
			(authRefreshTimer as any).unref?.();
		} catch {
			// noop
		}
	}
	for (const t of [staleScanTimer, ttlScanTimer, keepaliveTimer]) {
		try {
			(t as any).unref?.();
		} catch {
			// noop
		}
	}
}

function stopLoops(): void {
	if (staleScanTimer) clearInterval(staleScanTimer);
	if (ttlScanTimer) clearInterval(ttlScanTimer);
	if (keepaliveTimer) clearInterval(keepaliveTimer);
	if (authRefreshTimer) clearInterval(authRefreshTimer);
	staleScanTimer = null;
	ttlScanTimer = null;
	keepaliveTimer = null;
	authRefreshTimer = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// main() — only runs when launched directly
// ─────────────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
	// Token policy. Directory mode needs no shared token: the directory is the
	// perimeter, and PI_COMS_NET_AUTH_TOKEN (if set) is just the root principal.
	if (!TOKEN && !DIRECTORY_MODE) {
		if (!isLoopback(HOST)) {
			console.error(
				`coms-net: refusing to bind ${HOST} without an explicit PI_COMS_NET_AUTH_TOKEN.`,
			);
			process.exit(1);
		}
		TOKEN = crypto.randomBytes(32).toString("hex");
		TOKEN_FILE_OWNED_BY_US = true;
	} else {
		TOKEN_FILE_OWNED_BY_US = false;
	}

	// Load the token directory before accepting requests.
	if (DIRECTORY_MODE) {
		await refreshTokenDirectory();
		if (tokenDirectory.size === 0 && !TOKEN) {
			console.error(
				"coms-net: directory mode is on but no principals loaded and no root token set; nothing could ever authenticate.",
			);
			process.exit(1);
		}
	}

	const dir = projectDir(PROJECT);
	ensureDirSync(dir);

	// Mailbox recovery: reload non-terminal messages from every project's
	// messages.db. New server_id, same mail.
	recoverMail();

	// Boot Bun.serve.
	const server = (globalThis as any).Bun.serve({
		hostname: HOST,
		port: PORT,
		fetch: router,
		maxRequestBodySize: MAX_BODY_BYTES,
		// Bun's default idle timeout is 10s — bump it so SSE doesn't get cut.
		idleTimeout: 0,
	});
	const claimedPort: number = Number(server.port);
	const localHost = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
	const localUrl = `http://${localHost}:${claimedPort}`;
	const publicUrl = PUBLIC_URL ?? localUrl;

	// Write server.json (NEVER include the token).
	const serverJsonPath = path.join(dir, "server.json");
	const serverJson = {
		version: 1,
		project: PROJECT,
		pid: process.pid,
		host: HOST,
		port: claimedPort,
		local_url: localUrl,
		public_url: publicUrl,
		started_at: state.started_at,
		server_id: state.server_id,
	};
	atomicWriteSync(serverJsonPath, JSON.stringify(serverJson, null, 2));

	// Write server.secret.json only if we own the token.
	let secretPath: string | null = null;
	if (TOKEN_FILE_OWNED_BY_US) {
		secretPath = path.join(dir, "server.secret.json");
		atomicWriteSync(
			secretPath,
			JSON.stringify({ token: TOKEN }, null, 2),
			0o600,
		);
		try {
			fs.chmodSync(secretPath, 0o600);
		} catch {
			// best-effort
		}
	}

	// Boot banner — NEVER print the token. Path only.
	const bootDim = LOG_TTY ? C_DIM : "";
	const bootCyan = LOG_TTY ? C_CYAN : "";
	const bootReset = LOG_TTY ? C_RESET : "";
	console.log(`${bootCyan}coms-net${bootReset}: listening on ${bootCyan}${localUrl}${bootReset}`);
	console.log(`${bootDim}          project=${PROJECT} pid=${process.pid}${bootReset}`);
	console.log(`${bootDim}          server.json=${serverJsonPath}${bootReset}`);
	if (secretPath) {
		console.log(`${bootDim}          server.secret.json=${secretPath} (chmod 0600)${bootReset}`);
	} else {
		console.log(`${bootDim}          using token from PI_COMS_NET_AUTH_TOKEN${bootReset}`);
	}
	if (!LOG_QUIET) {
		console.log(`${bootDim}          ─── events below (Ctrl-C to quit, set PI_COMS_NET_LOG_HEARTBEAT=1 for heartbeat noise) ───${bootReset}`);
	}

	// Start cleanup loops.
	startLoops();

	// Synchronous unlink helper — must be safe to call multiple times and from any
	// termination path (signal handler, exit event, uncaught exception).
	let filesUnlinked = false;
	const unlinkStateFiles = () => {
		if (filesUnlinked) return;
		filesUnlinked = true;
		try {
			fs.unlinkSync(serverJsonPath);
		} catch {
			// noop
		}
		if (TOKEN_FILE_OWNED_BY_US && secretPath) {
			try {
				fs.unlinkSync(secretPath);
			} catch {
				// noop
			}
		}
	};

	// Signal handlers.
	const shutdown = (sig: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		// FIRST: unlink state files synchronously. This must happen before any other
		// work so that even if the process is hard-killed (SIGKILL from a parent
		// process manager racing the SIGINT handler) or the broadcast/stream-close
		// loop somehow stalls, the registry doesn't leak across runs.
		unlinkStateFiles();
		try {
			console.log(`coms-net: ${sig} received, shutting down`);
		} catch {
			// noop
		}
		// Notify all streams.
		for (const [projectName, p] of state.projects) {
			for (const [sid, entry] of p.agents) {
				broadcast(
					p,
					"agent_left",
					{
						project: projectName,
						session_id: sid,
						name: entry.name,
						reason: "shutdown",
					},
					sid,
				);
			}
			for (const [, w] of p.streams) {
				try {
					w.close();
				} catch {
					// noop
				}
			}
			p.streams.clear();
		}
		// Stop loops.
		stopLoops();
		// Stop server.
		try {
			server.stop?.(true);
		} catch {
			// noop
		}
		// Allow IO to flush.
		setTimeout(() => process.exit(0), 50).unref?.();
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	// Belt-and-suspenders: any other path to process termination (uncaught
	// exception, explicit process.exit, normal exit) gets a final synchronous
	// chance to unlink. Note: this does NOT fire on SIGKILL.
	process.on("exit", () => {
		unlinkStateFiles();
	});
}

if (import.meta.main) {
	void main();
}
