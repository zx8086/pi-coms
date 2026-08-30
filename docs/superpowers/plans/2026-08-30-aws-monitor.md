# AWS Account Monitor and Hub Mailbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hub store-and-forward for coms-net messages plus a per-host monitor process that runs scheduled AWS checks, delegates diagnosis to the account's Pi agent, and mails durable reports to the operator.

**Architecture:** Two subsystems. (1) The hub (`scripts/coms-net-server.ts`, single self-contained file — the Dockerfile copies only it) gains a `bun:sqlite` write-through mailbox, flush-on-connect, optional `ttl_ms`, and restart recovery. (2) A new standalone Bun process (`scripts/coms-net-monitor.ts` + `scripts/monitor/`) registers as an explicit coms-net peer, runs deterministic AWS checks on `Bun.cron`, investigates warn+ findings via the account's Pi agent, and reports with long TTL.

**Tech Stack:** Bun 1.4 (`Bun.cron(schedule, handler)` in-process overload — verified present, returns handle with `stop/ref/unref`), `bun:sqlite`, `bun test`, zod, AWS SDK v3 (`@aws-sdk/client-cloudwatch`, `client-cloudwatch-logs`, `client-ec2`, `client-cost-explorer`), Terraform, systemd.

**Spec:** `docs/superpowers/specs/2026-08-30-aws-monitor-design.md` (Linear SIO-1575)

## Global Constraints

- Ticket: SIO-1575. Branch: `simonowusupvh/sio-1575-aws-account-monitor-and-coms-net-hub-mailbox` off `fix/poc-subnet-passthrough`.
- Hub mailbox code lives INSIDE `scripts/coms-net-server.ts` (the hub Dockerfile copies only that file; it must stay self-contained, Bun stdlib only).
- Default message TTL stays `PI_COMS_NET_MESSAGE_TTL_MS` = 30 min. New cap: `PI_COMS_NET_MAX_TTL_MS` default 7 days (604800000).
- Mailbox DB: `~/.pi/coms-net/projects/<project>/messages.db`, WAL. Monitor state DB: `~/.pi/monitor/state.db`, WAL.
- Monitor peer name `monitor-aws-<account_id>`, registered `explicit: true`. No model calls inside the monitor; zero token spend when quiet.
- Cost alert only when yesterday exceeds the 14-day baseline by BOTH +20% and +$1.
- Reports go to `PI_MONITOR_REPORT_TO` (default `laptop`) with long TTL. Daily digest ships even when quiet.
- No emojis in code/logs/commits. Tabs for indentation (match existing files). `bun test` must pass at every commit.
- Syntax check for extension/server files: `bun build <file> --external '*' --outfile /dev/null`.
- Out of scope: CI wiring, Couchbase memory, per-peer hub auth, remediation, Windows.

## File Structure

| File | Change |
|------|--------|
| `scripts/coms-net-server.ts` | Mailbox: `MailStore` class, write-through, flush-on-connect, `ttl_ms`, recovery |
| `extensions/coms-net.ts` | `ttl_ms` pass-through on `coms_net_send` |
| `scripts/monitor/report.ts` | New: zod Finding/Diagnosis schemas, report + digest formatting |
| `scripts/monitor/state.ts` | New: `MonitorState` sqlite (watermarks, fingerprints, snapshots, costs, journal, unsent) |
| `scripts/monitor/checks/{alarms,logs,drift,cost}.ts` | New: one check per family, AWS client injected |
| `scripts/monitor/coms.ts` | New: minimal coms-net client for a headless Bun process |
| `scripts/coms-net-monitor.ts` | New: monitor entrypoint (Bun.cron, cycle, commands) |
| `tests/*.test.ts` | New: first test suite in the repo |
| `deploy/hub/Dockerfile` | Pre-create `/home/bun/.pi` so the volume mounts writable |
| `deploy/hostinger/docker-compose.yml` | Named volume for the mailbox |
| `deploy/bootstrap/agent-bootstrap.sh` | Install `pi-monitor.service` |
| `deploy/modules/agent/main.tf` | `ce:GetCostAndUsage` inline policy |

---

### Task 0: Branch

- [ ] **Step 1: Create the work branch**

```bash
git checkout fix/poc-subnet-passthrough
git checkout -b simonowusupvh/sio-1575-aws-account-monitor-and-coms-net-hub-mailbox
```

---

### Task 1: MailStore (sqlite layer inside the server)

**Files:**
- Modify: `scripts/coms-net-server.ts` (types at ~130-260, add class after helpers ~line 375)
- Test: `tests/mailstore.test.ts`

**Interfaces:**
- Produces: `export class MailStore` with `upsert(m: ComsMessage)`, `remove(msg_id: string)`, `loadNonTerminal(): ComsMessage[]`, `close()`; widened `ComsMessage` with `target_session: string | null`, `target_name: string | null`, `sender_name: string`, `sender_cwd: string`; `SendRequest.ttl_ms?: number | null`; env `PI_COMS_NET_MAX_TTL_MS`.

- [ ] **Step 1: Widen the shared types**

In `scripts/coms-net-server.ts`, change `ComsMessage` (line ~161):

```ts
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
	response?: any;
	error?: string | null;
	created_at: string;
	delivered_at?: string;
	completed_at?: string;
	expires_at: string;
};
```

Add `ttl_ms?: number | null;` to `SendRequest`, and change `SendResponse.target_session` to `string | null`. Add near the other env reads (line ~39):

```ts
const MAX_TTL_MS = Number(process.env.PI_COMS_NET_MAX_TTL_MS ?? 604_800_000);
```

Fix the two places that assume `target_session` is a string: `inboxDepthFor` already skips non-matching (null never equals a session id — no change), and `handleSubmitResponse`'s `body.responder_session !== msg.target_session` correctly rejects unclaimed mail — no change, but verify while editing.

- [ ] **Step 2: Write the failing unit test**

`tests/mailstore.test.ts`:

```ts
// tests/mailstore.test.ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MailStore, type ComsMessage } from "../scripts/coms-net-server.ts";

function tmpDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailstore-"));
	return path.join(dir, "messages.db");
}

function msg(over: Partial<ComsMessage> = {}): ComsMessage {
	return {
		msg_id: over.msg_id ?? crypto.randomUUID(),
		project: "default",
		sender_session: "S1",
		sender_name: "monitor",
		sender_cwd: "/tmp",
		target_session: null,
		target_name: "laptop",
		prompt: "hello",
		conversation_id: null,
		response_schema: null,
		hops: 0,
		status: "queued",
		response: null,
		error: null,
		created_at: new Date().toISOString(),
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		...over,
	};
}

describe("MailStore", () => {
	test("upsert then loadNonTerminal round-trips queued mail", () => {
		const store = new MailStore(tmpDb());
		const m = msg();
		store.upsert(m);
		const loaded = store.loadNonTerminal();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]).toEqual(m);
		store.close();
	});

	test("terminal statuses are not reloaded", () => {
		const store = new MailStore(tmpDb());
		store.upsert(msg({ msg_id: "A", status: "complete" }));
		store.upsert(msg({ msg_id: "B", status: "error" }));
		store.upsert(msg({ msg_id: "C", status: "timeout" }));
		store.upsert(msg({ msg_id: "D", status: "delivered" }));
		const ids = store.loadNonTerminal().map((m) => m.msg_id);
		expect(ids).toEqual(["D"]);
		store.close();
	});

	test("upsert replaces in place and remove deletes", () => {
		const store = new MailStore(tmpDb());
		const m = msg({ msg_id: "X" });
		store.upsert(m);
		store.upsert({ ...m, status: "delivered", target_session: "S2" });
		const loaded = store.loadNonTerminal();
		expect(loaded[0].status).toBe("delivered");
		expect(loaded[0].target_session).toBe("S2");
		store.remove("X");
		expect(store.loadNonTerminal()).toHaveLength(0);
		store.close();
	});

	test("persists across reopen (same file)", () => {
		const dbPath = tmpDb();
		const a = new MailStore(dbPath);
		a.upsert(msg({ msg_id: "P" }));
		a.close();
		const b = new MailStore(dbPath);
		expect(b.loadNonTerminal().map((m) => m.msg_id)).toEqual(["P"]);
		b.close();
	});
});
```

- [ ] **Step 3: Run it — expect FAIL** (`MailStore` not exported): `bun test tests/mailstore.test.ts`

- [ ] **Step 4: Implement `MailStore`**

Add to `scripts/coms-net-server.ts` after the helpers section (import `Database` at top: `import { Database } from "bun:sqlite";`):

```ts
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
			response TEXT,
			error TEXT,
			created_at TEXT NOT NULL,
			delivered_at TEXT,
			completed_at TEXT,
			expires_at TEXT NOT NULL
		)`);
	}
	upsert(m: ComsMessage): void {
		this.db.query(`INSERT INTO messages (msg_id, project, sender_session, sender_name, sender_cwd,
			target_session, target_name, prompt, conversation_id, response_schema, hops, status,
			response, error, created_at, delivered_at, completed_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(msg_id) DO UPDATE SET target_session=excluded.target_session,
			target_name=excluded.target_name, status=excluded.status, response=excluded.response,
			error=excluded.error, delivered_at=excluded.delivered_at,
			completed_at=excluded.completed_at, expires_at=excluded.expires_at`).run(
			m.msg_id, m.project, m.sender_session, m.sender_name, m.sender_cwd,
			m.target_session, m.target_name, m.prompt, m.conversation_id,
			m.response_schema ? JSON.stringify(m.response_schema) : null, m.hops, m.status,
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
			status: r.status,
			response: r.response == null ? null : JSON.parse(r.response),
			error: r.error,
			created_at: r.created_at,
			...(r.delivered_at ? { delivered_at: r.delivered_at } : {}),
			...(r.completed_at ? { completed_at: r.completed_at } : {}),
			expires_at: r.expires_at,
		}));
	}
	close(): void {
		try { this.db.close(); } catch { /* noop */ }
	}
}
```

Note the test uses `toEqual(m)` on a message with no `delivered_at` — the mapper must omit absent optional keys (spread pattern above), not set them `undefined`... `toEqual` treats `undefined` fields as equal, but keep the spread pattern anyway for JSON cleanliness.

Also update the two existing `msg` constructions in `handleSendMessage` to set the new fields (done properly in Task 2 — for this commit just add `sender_name: sender.name, sender_cwd: sender.cwd, target_name: target.name` to the literal so the file compiles).

- [ ] **Step 5: Run tests + syntax check — expect PASS**

```bash
bun test tests/mailstore.test.ts
bun build scripts/coms-net-server.ts --external '*' --outfile /dev/null
```

- [ ] **Step 6: Commit** `feat(hub): MailStore sqlite layer for message durability`

---

### Task 2: Server send path — ttl_ms, name-queueing, write-through

**Files:**
- Modify: `scripts/coms-net-server.ts` — `handleSendMessage` (line ~823), state (`ProjectState` untouched), add `mailFor()`
- Test: `tests/mailbox.integration.test.ts` (new; shared harness used by Task 3)

**Interfaces:**
- Consumes: `MailStore` (Task 1).
- Produces: module-scope `mailStores: Map<string, MailStore>` + `function mailFor(project: string): MailStore`; send behavior: `ttl_ms > MESSAGE_TTL_MS` to an offline NAME returns 200 `{status:"queued", target_session: null}`; short/no TTL keeps `target_not_found` 404. All message mutations call `mailFor(project).upsert(msg)`.

- [ ] **Step 1: Test harness + failing integration tests**

`tests/mailbox.integration.test.ts` — harness spawns the real server with `HOME` in a temp dir:

```ts
// tests/mailbox.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TOKEN = "test-token-mailbox";
const SERVER = path.join(import.meta.dir, "..", "scripts", "coms-net-server.ts");

type Hub = { proc: Bun.Subprocess; url: string; home: string };
const hubs: Hub[] = [];

async function startHub(home?: string): Promise<Hub> {
	const h = home ?? fs.mkdtempSync(path.join(os.tmpdir(), "hub-home-"));
	const proc = Bun.spawn(["bun", SERVER], {
		env: {
			...process.env,
			HOME: h,
			PI_COMS_NET_HOST: "127.0.0.1",
			PI_COMS_NET_PORT: "0",
			PI_COMS_NET_AUTH_TOKEN: TOKEN,
			PI_COMS_NET_LOG_QUIET: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	// server.json appears once the port is bound
	const sj = path.join(h, ".pi", "coms-net", "projects", "default", "server.json");
	for (let i = 0; i < 100; i++) {
		if (fs.existsSync(sj)) break;
		await Bun.sleep(50);
	}
	const url = JSON.parse(fs.readFileSync(sj, "utf-8")).local_url as string;
	const hub = { proc, url, home: h };
	hubs.push(hub);
	return hub;
}

async function stopHub(hub: Hub): Promise<void> {
	hub.proc.kill("SIGTERM");
	await hub.proc.exited;
}

afterEach(async () => {
	while (hubs.length) await stopHub(hubs.pop()!);
});

async function api(hub: Hub, method: string, p: string, body?: unknown): Promise<Response> {
	return fetch(hub.url + p, {
		method,
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function register(hub: Hub, session_id: string, name: string): Promise<string> {
	const r = await api(hub, "POST", "/v1/agents/register", {
		project: "default", session_id, name, purpose: "", model: "test",
		color: "#888888", cwd: "/tmp", explicit: false,
	});
	expect(r.status).toBe(200);
	return ((await r.json()) as any).sse_url as string;
}

function send(hub: Hub, sender: string, target: string, prompt: string, ttl_ms?: number) {
	return api(hub, "POST", "/v1/messages", {
		project: "default", sender_session: sender, target, target_session: null,
		prompt, conversation_id: null, response_schema: null, hops: 0,
		...(ttl_ms !== undefined ? { ttl_ms } : {}),
	});
}

describe("mailbox send", () => {
	test("long-TTL send to an offline name queues instead of 404", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		const r = await send(hub, "SENDER", "laptop", "report 1", 86_400_000);
		expect(r.status).toBe(200);
		const body = (await r.json()) as any;
		expect(body.status).toBe("queued");
		expect(body.target_session).toBeNull();
	});

	test("short-TTL send to an offline name keeps failing fast", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		const r = await send(hub, "SENDER", "laptop", "quick question");
		expect(r.status).toBe(404);
		const r2 = await send(hub, "SENDER", "laptop", "quick question", 60_000);
		expect(r2.status).toBe(404);
	});

	test("ttl_ms is capped by PI_COMS_NET_MAX_TTL_MS default 7 days", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		const r = await send(hub, "SENDER", "laptop", "hi", 999_999_999_999);
		expect(r.status).toBe(200);
		// row is on disk with a capped expiry
		const db = path.join(hub.home, ".pi", "coms-net", "projects", "default", "messages.db");
		expect(fs.existsSync(db)).toBe(true);
		const { Database } = await import("bun:sqlite");
		const row = new Database(db, { readonly: true })
			.query("SELECT expires_at FROM messages").get() as any;
		const ttl = Date.parse(row.expires_at) - Date.now();
		expect(ttl).toBeLessThanOrEqual(604_800_000 + 5_000);
		expect(ttl).toBeGreaterThan(600_000_000);
	});

	test("online target with long ttl delivers normally", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		const sseUrl = await register(hub, "TGT", "laptop");
		// open the target's SSE stream so delivery can happen
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(resp.status).toBe(200);
		await Bun.sleep(100);
		const r = await send(hub, "SENDER", "laptop", "hello there", 86_400_000);
		const body = (await r.json()) as any;
		expect(body.status).toBe("delivered");
		expect(body.target_session).toBe("TGT");
		resp.body?.cancel();
	});
});
```

- [ ] **Step 2: Run — expect FAIL** (404 on the queue test): `bun test tests/mailbox.integration.test.ts`

- [ ] **Step 3: Implement the send path**

In `scripts/coms-net-server.ts`:

Module scope (near `state`):

```ts
const mailStores = new Map<string, MailStore>();
function mailFor(project: string): MailStore {
	let s = mailStores.get(project);
	if (!s) {
		s = new MailStore(path.join(projectDir(project), "messages.db"));
		mailStores.set(project, s);
	}
	return s;
}
```

`handleSendMessage` changes:

1. Parse TTL after the hop check:

```ts
	const requestedTtl =
		typeof body.ttl_ms === "number" && body.ttl_ms > 0
			? Math.min(body.ttl_ms, MAX_TTL_MS)
			: MESSAGE_TTL_MS;
	const isMailbox = requestedTtl > MESSAGE_TTL_MS;
```

2. In target resolution, the name-miss branch (`if (!bag || bag.size === 0)`) becomes:

```ts
			if (!bag || bag.size === 0) {
				if (isMailbox) {
					// Store-and-forward: queue by name for the next session
					// registering under it. target stays unresolved.
					const created = nowIso();
					const msg: ComsMessage = {
						msg_id: ulid(),
						project: projectName,
						sender_session: body.sender_session,
						sender_name: sender.name,
						sender_cwd: sender.cwd,
						target_session: null,
						target_name: desired,
						prompt: body.prompt,
						conversation_id: body.conversation_id ?? null,
						response_schema: body.response_schema ?? null,
						hops,
						status: "queued",
						response: null,
						error: null,
						created_at: created,
						expires_at: new Date(Date.now() + requestedTtl).toISOString(),
					};
					p.messages.set(msg.msg_id, msg);
					mailFor(projectName).upsert(msg);
					sendToStream(p, body.sender_session, "message_status", { msg_id: msg.msg_id, status: "queued" });
					logMessageSend(sender.name, `${desired}(offline)`, msg.msg_id, msg.prompt, hops, false);
					return json({ ok: true, msg_id: msg.msg_id, status: "queued", target_session: null });
				}
				logRejected("target_not_found", `${sender.name} → "${desired}"`);
				return errorJson("target_not_found", 404, { target: desired });
			}
```

3. The normal path: build `msg` with `sender_name: sender.name, sender_cwd: sender.cwd, target_name: target.name`, `expires_at` from `requestedTtl`; after `p.messages.set(...)` add `mailFor(projectName).upsert(msg);` and after the delivered transition add another `mailFor(projectName).upsert(msg);`.

4. Validate `conversation_id`/`response_schema` as before (keep the existing typeof guards).

- [ ] **Step 4: Run tests + syntax check — expect PASS**

```bash
bun test tests/mailbox.integration.test.ts tests/mailstore.test.ts
bun build scripts/coms-net-server.ts --external '*' --outfile /dev/null
```

- [ ] **Step 5: Commit** `feat(hub): ttl_ms with name-addressed queueing for offline peers`

---

### Task 3: Flush-on-connect, restart recovery, sweep write-through

**Files:**
- Modify: `scripts/coms-net-server.ts` — `handleEvents` (line ~605), `handleSubmitResponse` (~1106), `ttlScanTick` (~1367), `main()` (~1441)
- Test: extend `tests/mailbox.integration.test.ts`

**Interfaces:**
- Consumes: `mailFor` (Task 2).
- Produces: `function flushQueuedMail(p: ProjectState, projectName: string, sessionId: string): void` called from `handleEvents` after `pool_snapshot`; `function recoverMail(): void` called from `main()`.

- [ ] **Step 1: Failing tests**

Append to `tests/mailbox.integration.test.ts` (reuses the harness; an SSE reader helper is needed):

```ts
async function readSseEvents(resp: Response, wanted: string, count: number, timeoutMs = 5_000): Promise<any[]> {
	const reader = resp.body!.getReader();
	const dec = new TextDecoder();
	let buf = "";
	const out: any[] = [];
	const deadline = Date.now() + timeoutMs;
	while (out.length < count && Date.now() < deadline) {
		const { done, value } = await Promise.race([
			reader.read(),
			Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined as any })),
		]);
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let idx;
		while ((idx = buf.indexOf("\n\n")) >= 0) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			let event = "message";
			let data = "";
			for (const line of frame.split("\n")) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				if (line.startsWith("data:")) data = line.slice(5).trim();
			}
			if (event === wanted && data) out.push(JSON.parse(data));
		}
	}
	reader.releaseLock();
	return out;
}

describe("mailbox flush and recovery", () => {
	test("queued mail flushes oldest-first when the name registers", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		await send(hub, "SENDER", "laptop", "first", 86_400_000);
		await Bun.sleep(10);
		await send(hub, "SENDER", "laptop", "second", 86_400_000);
		const sseUrl = await register(hub, "LAP", "laptop");
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		const prompts = await readSseEvents(resp, "prompt", 2);
		expect(prompts.map((p) => p.prompt)).toEqual(["first", "second"]);
		expect(prompts[0].sender.name).toBe("monitor");
		resp.body?.cancel();
	});

	test("queued mail survives a hub restart", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		await send(hub, "SENDER", "laptop", "durable report", 86_400_000);
		const home = hub.home;
		await stopHub(hubs.pop()!);
		const hub2 = await startHub(home);
		const sseUrl = await register(hub2, "LAP2", "laptop");
		const resp = await fetch(hub2.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		const prompts = await readSseEvents(resp, "prompt", 1);
		expect(prompts[0].prompt).toBe("durable report");
		expect(prompts[0].sender.name).toBe("monitor");
		resp.body?.cancel();
	});

	test("responding to flushed mail works end to end", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		const s = await send(hub, "SENDER", "laptop", "ack me", 86_400_000);
		const { msg_id } = (await s.json()) as any;
		const sseUrl = await register(hub, "LAP", "laptop");
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		const [prompt] = await readSseEvents(resp, "prompt", 1);
		const rr = await api(hub, "POST", `/v1/messages/${prompt.msg_id}/response`, {
			project: "default", responder_session: "LAP", response: "acked", error: null,
		});
		expect(rr.status).toBe(200);
		const g = await api(hub, "GET", `/v1/messages/${msg_id}`);
		expect(((await g.json()) as any).response).toBe("acked");
		resp.body?.cancel();
	});
});
```

- [ ] **Step 2: Run — expect FAIL** (no prompt events arrive / restart loses mail).

- [ ] **Step 3: Implement**

In `scripts/coms-net-server.ts`:

`flushQueuedMail` (module scope, near `broadcast`):

```ts
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
		});
		m.status = "delivered";
		m.delivered_at = nowIso();
		mail.upsert(m);
		sendToStream(p, m.sender_session, "message_status", { msg_id: m.msg_id, status: "delivered" });
		logMessageSend(m.sender_name, entry.name, m.msg_id, m.prompt, m.hops, true);
	}
}
```

In `handleEvents`'s `start()` — after the `pool_snapshot` enqueue and BEFORE the abort handler registration, add:

```ts
				// Mailbox: flush queued messages for this session, oldest first.
				flushQueuedMail(p, projectName, session_id);
```

(`p.streams.set(session_id, writer)` already ran, so `sendToStream` reaches this stream; frames are queued into the controller in order after hello/pool_snapshot.)

`recoverMail` (module scope) + call as the first thing in `main()` after the token policy block:

```ts
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
			// re-queued so the next session under the name gets it again.
			if (m.status === "delivered") {
				m.status = "queued";
				m.target_session = null;
				delete m.delivered_at;
				mailFor(name).upsert(m);
			} else if (m.target_session !== null) {
				// queued to a session id that no longer exists; requeue by name
				m.target_session = null;
				mailFor(name).upsert(m);
			}
			p.messages.set(m.msg_id, m);
		}
	}
}
```

Wait — re-queueing DELIVERED mail on restart risks double delivery when the peer already answered but the answer was lost; acceptable for v1 (at-least-once for mailbox sends). But it must not resurrect short-TTL interactive messages: those expire on the normal sweep anyway (30 min), and only non-terminal rows load. Keep it.

Write-through on the remaining transitions:

- `handleSubmitResponse`: after `msg.completed_at = nowIso();` add `mailFor(msg.project).upsert(msg);`
- `ttlScanTick`: in the expire branch add `mailFor(...)`— the loop has the project map value but not its name; change the outer loop to `for (const [projectName, p] of state.projects)` and add `mailFor(projectName).remove(id);` next to every `p.messages.delete(id)` (three places).
- `handleDeleteAgent` / stale reaping do not touch messages — no change.

- [ ] **Step 4: Run the full suite + syntax check — expect PASS**

```bash
bun test
bun build scripts/coms-net-server.ts --external '*' --outfile /dev/null
```

- [ ] **Step 5: Commit** `feat(hub): flush-on-connect and restart recovery for the mailbox`

---

### Task 4: Hub container durability

**Files:**
- Modify: `deploy/hub/Dockerfile`, `deploy/hostinger/docker-compose.yml`

- [ ] **Step 1: Dockerfile — pre-create the state dir so the named volume mounts writable**

```dockerfile
FROM oven/bun:1.3-alpine

WORKDIR /app
COPY scripts/coms-net-server.ts ./scripts/coms-net-server.ts

# The mailbox lives under ~/.pi/coms-net (a named volume). Create it owned by
# bun before dropping privileges, or the volume mounts root-owned and sqlite
# cannot create messages.db.
RUN mkdir -p /home/bun/.pi/coms-net && chown -R bun:bun /home/bun/.pi

ENV PI_COMS_NET_HOST=0.0.0.0 \
    PI_COMS_NET_PORT=8787 \
    PI_COMS_NET_LOG_HEARTBEAT=0

EXPOSE 8787
USER bun
CMD ["bun", "scripts/coms-net-server.ts"]
```

- [ ] **Step 2: compose — named volume**

In `deploy/hostinger/docker-compose.yml` add to the `coms-hub` service:

```yaml
    # Mailbox durability: messages.db survives container recreation.
    volumes:
      - coms-hub-mail:/home/bun/.pi/coms-net
```

and at file end:

```yaml
volumes:
  coms-hub-mail:
```

- [ ] **Step 3: Verify** `docker compose -f deploy/hostinger/docker-compose.yml config -q` (if docker present; otherwise YAML-parse with `bun -e "const y = await Bun.file('deploy/hostinger/docker-compose.yml').text(); Bun.YAML.parse(y); console.log('ok')"`).

- [ ] **Step 4: Commit** `feat(deploy): persist hub mailbox across container recreation`

---

### Task 5: Client ttl_ms pass-through

**Files:**
- Modify: `extensions/coms-net.ts` — `SendRequest` (line ~107), `coms_net_send` tool (~1185)

**Interfaces:**
- Produces: `coms_net_send` accepts optional `ttl_ms` (number, ms); flushed-on-connect prompts need no client change (they arrive as ordinary `prompt` events, each triggering a follow-up turn in arrival order — verify by reading `handleInboundPrompt`, no code change expected).

- [ ] **Step 1: Add `ttl_ms?: number | null;` to the client's `SendRequest` interface.**

- [ ] **Step 2: Tool surface** — in the `coms_net_send` parameters object add:

```ts
				ttl_ms: Type.Optional(Type.Number({ description: "Optional TTL in ms. Beyond the server default (30 min) the message is queued durably for an offline peer name and delivered when it next registers. Capped by the server (default 7 days)." })),
```

and in `execute`, the request literal gains:

```ts
					ttl_ms: typeof (params as any).ttl_ms === "number" && (params as any).ttl_ms > 0 ? (params as any).ttl_ms : null,
```

Also `target_session` from the response may now be `null` (queued-by-name); the existing code only stores it in `pendingReplies` — no behavioral change, but the send result text should show `status` so a queued mailbox send is visible. Change the returned text to include `resp.status`.

- [ ] **Step 3: Syntax check** `bun build extensions/coms-net.ts --external '*' --outfile /dev/null`

- [ ] **Step 4: Commit** `feat(coms-net): ttl_ms pass-through on coms_net_send`

---

### Task 6: Monitor deps + report module

**Files:**
- Modify: `package.json` (via `bun add`)
- Create: `scripts/monitor/report.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Produces: zod schemas `FindingSchema`, `DiagnosisSchema`; types `Finding`, `Diagnosis`, `Severity`; `DIAGNOSIS_RESPONSE_SCHEMA` (plain JSON schema for coms `response_schema`); `parseDiagnoses(raw: unknown): Map<string, Diagnosis> | null`; `formatIncidentReport(accountId: string, items: { finding: Finding; diagnosis: Diagnosis | null }[]): string`; `formatDigest(d: DigestInput): string` with `type DigestInput = { accountId: string; since: string; findingCounts: Record<string, number>; checkErrors: number; activeAlarms: string[]; yesterdayUsd: number | null; baselineUsd: number | null }`.

- [ ] **Step 1: Install deps** (required by the approved spec; the agent bootstrap already runs `bun install`):

```bash
bun add zod @aws-sdk/client-cloudwatch @aws-sdk/client-cloudwatch-logs @aws-sdk/client-ec2 @aws-sdk/client-cost-explorer
```

- [ ] **Step 2: Failing test** `tests/report.test.ts`:

```ts
// tests/report.test.ts
import { describe, expect, test } from "bun:test";
import {
	DiagnosisSchema, FindingSchema, formatDigest, formatIncidentReport, parseDiagnoses,
} from "../scripts/monitor/report.ts";

const finding = {
	family: "alarm" as const, severity: "critical" as const,
	resource: "cpu-high", summary: "Alarm cpu-high entered ALARM",
	dedup_key: "alarm:cpu-high:ALARM", evidence: { state: "ALARM" },
	at: "2026-08-30T00:00:00.000Z",
};

describe("report", () => {
	test("FindingSchema accepts a finding and rejects bad severity", () => {
		expect(FindingSchema.safeParse(finding).success).toBe(true);
		expect(FindingSchema.safeParse({ ...finding, severity: "bad" }).success).toBe(false);
	});

	test("parseDiagnoses maps by dedup_key and rejects garbage", () => {
		const good = { diagnoses: [{ dedup_key: "alarm:cpu-high:ALARM", probable_cause: "load spike", affected_resources: ["i-123"], suggested_action: "check autoscaling" }] };
		const map = parseDiagnoses(good);
		expect(map?.get("alarm:cpu-high:ALARM")?.probable_cause).toBe("load spike");
		expect(parseDiagnoses("not json shaped")).toBeNull();
		expect(parseDiagnoses({ diagnoses: [{ nope: 1 }] })).toBeNull();
	});

	test("incident report leads with severity and includes diagnosis", () => {
		const diag = DiagnosisSchema.parse({ probable_cause: "load spike", affected_resources: ["i-123"], suggested_action: "check autoscaling" });
		const text = formatIncidentReport("111122223333", [{ finding, diagnosis: diag }]);
		expect(text.startsWith("[critical]")).toBe(true);
		expect(text).toContain("cpu-high");
		expect(text).toContain("load spike");
	});

	test("uninvestigated findings carry a marker", () => {
		const text = formatIncidentReport("111122223333", [{ finding, diagnosis: null }]);
		expect(text).toContain("uninvestigated");
	});

	test("digest renders even when quiet", () => {
		const text = formatDigest({
			accountId: "111122223333", since: "2026-08-29T00:00:00Z",
			findingCounts: {}, checkErrors: 0, activeAlarms: [],
			yesterdayUsd: 1.23, baselineUsd: 1.1,
		});
		expect(text).toContain("daily digest");
		expect(text).toContain("no findings");
		expect(text).toContain("1.23");
	});
});
```

- [ ] **Step 3: Run — expect FAIL** (module missing). **Step 4: Implement** `scripts/monitor/report.ts`:

```ts
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
): string {
	const sorted = [...items].sort((a, b) => SEV_ORDER[a.finding.severity] - SEV_ORDER[b.finding.severity]);
	const top = sorted[0]?.finding.severity ?? "info";
	const lines: string[] = [
		`[${top}] aws-${accountId}: ${sorted.length} finding(s)`,
		"",
	];
	for (const { finding, diagnosis } of sorted) {
		lines.push(`- (${finding.severity}/${finding.family}) ${finding.resource}: ${finding.summary}`);
		if (diagnosis) {
			lines.push(`  cause: ${diagnosis.probable_cause}`);
			if (diagnosis.affected_resources.length > 0) lines.push(`  affected: ${diagnosis.affected_resources.join(", ")}`);
			lines.push(`  action: ${diagnosis.suggested_action}`);
		} else if (finding.severity !== "info") {
			lines.push("  (uninvestigated: agent unavailable or response invalid)");
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
	lines.push(d.activeAlarms.length === 0 ? "- alarms: none in ALARM" : `- alarms in ALARM: ${d.activeAlarms.join(", ")}`);
	if (d.yesterdayUsd != null) {
		const base = d.baselineUsd != null ? ` vs 14d baseline $${d.baselineUsd.toFixed(2)}` : "";
		lines.push(`- spend yesterday: $${d.yesterdayUsd.toFixed(2)}${base}`);
	} else {
		lines.push("- spend: no cost data yet");
	}
	return lines.join("\n");
}
```

- [ ] **Step 5: Run — expect PASS**: `bun test tests/report.test.ts`
- [ ] **Step 6: Commit** `feat(monitor): finding and diagnosis schemas, report formatting` (include `package.json` + `bun.lock`)

---

### Task 7: Monitor state module

**Files:**
- Create: `scripts/monitor/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Produces `export class MonitorState`:
  - `constructor(dbPath: string)` (`":memory:"` in tests), `close()`
  - watermarks: `getWatermark(key: string): number | null`, `setWatermark(key: string, ts: number): void`
  - fingerprints: `shouldAlert(key: string, reAlertMs?: number): boolean` (true when never alerted, or last alert older than `reAlertMs`; omitted `reAlertMs` = alert once until cleared), `markAlerted(key: string, family: string): void`, `clearAlerts(prefix: string): void`, `alertKeys(prefix: string): string[]`
  - snapshots: `getSnapshot(name: string): Record<string, string> | null`, `setSnapshot(name: string, v: Record<string, string>): void`
  - costs: `recordCost(date: string, usd: number): void` (upsert), `costBaseline(excludeDate: string, days: number): number | null` (mean of up to `days` most recent rows before `excludeDate`; null when none), `latestCost(): { date: string; usd: number } | null`
  - journal: `journal(kind: string, payload: unknown): void`, `journalRows(sinceMs: number, kind?: string): { ts: string; kind: string; payload: string }[]`, `priorIncidents(resource: string, limit: number): { ts: string; payload: string }[]` (kind `finding`, payload LIKE resource match, newest first)
  - unsent: `queueUnsent(target: string, prompt: string, ttlMs: number): void`, `unsent(): { id: number; target: string; prompt: string; ttl_ms: number }[]`, `deleteUnsent(id: number): void`

- [ ] **Step 1: Failing test** `tests/state.test.ts`:

```ts
// tests/state.test.ts
import { describe, expect, test } from "bun:test";
import { MonitorState } from "../scripts/monitor/state.ts";

describe("MonitorState", () => {
	test("watermarks round-trip", () => {
		const s = new MonitorState(":memory:");
		expect(s.getWatermark("logs:/aws/x")).toBeNull();
		s.setWatermark("logs:/aws/x", 1000);
		s.setWatermark("logs:/aws/x", 2000);
		expect(s.getWatermark("logs:/aws/x")).toBe(2000);
	});

	test("fingerprints: alert once until cleared", () => {
		const s = new MonitorState(":memory:");
		expect(s.shouldAlert("alarm:a:ALARM")).toBe(true);
		s.markAlerted("alarm:a:ALARM", "alarm");
		expect(s.shouldAlert("alarm:a:ALARM")).toBe(false);
		expect(s.alertKeys("alarm:a:")).toEqual(["alarm:a:ALARM"]);
		s.clearAlerts("alarm:a:");
		expect(s.shouldAlert("alarm:a:ALARM")).toBe(true);
	});

	test("fingerprints: re-alert window", () => {
		const s = new MonitorState(":memory:");
		s.markAlerted("logs:g:sig", "logs");
		expect(s.shouldAlert("logs:g:sig", 60_000)).toBe(false);
		expect(s.shouldAlert("logs:g:sig", -1)).toBe(true); // window already elapsed
	});

	test("snapshots round-trip JSON", () => {
		const s = new MonitorState(":memory:");
		expect(s.getSnapshot("instances")).toBeNull();
		s.setSnapshot("instances", { "i-1": "running" });
		expect(s.getSnapshot("instances")).toEqual({ "i-1": "running" });
	});

	test("cost baseline is the mean of prior days, excluding the target day", () => {
		const s = new MonitorState(":memory:");
		expect(s.costBaseline("2026-08-30", 14)).toBeNull();
		for (let d = 1; d <= 14; d++) s.recordCost(`2026-08-${String(d).padStart(2, "0")}`, 1.0);
		s.recordCost("2026-08-30", 99);
		expect(s.costBaseline("2026-08-30", 14)).toBeCloseTo(1.0);
	});

	test("journal and prior incidents", () => {
		const s = new MonitorState(":memory:");
		s.journal("finding", { resource: "cpu-high", summary: "went ALARM" });
		s.journal("finding", { resource: "other", summary: "x" });
		s.journal("run", { ok: true });
		expect(s.journalRows(60_000)).toHaveLength(3);
		expect(s.journalRows(60_000, "finding")).toHaveLength(2);
		const prior = s.priorIncidents("cpu-high", 5);
		expect(prior).toHaveLength(1);
		expect(prior[0].payload).toContain("went ALARM");
	});

	test("unsent queue", () => {
		const s = new MonitorState(":memory:");
		s.queueUnsent("laptop", "report", 1000);
		const rows = s.unsent();
		expect(rows).toHaveLength(1);
		expect(rows[0].target).toBe("laptop");
		s.deleteUnsent(rows[0].id);
		expect(s.unsent()).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `scripts/monitor/state.ts`:

```ts
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
	close(): void { try { this.db.close(); } catch { /* noop */ } }

	getWatermark(key: string): number | null {
		const r = this.db.query("SELECT ts FROM watermarks WHERE key = ?").get(key) as any;
		return r ? Number(r.ts) : null;
	}
	setWatermark(key: string, ts: number): void {
		this.db.query("INSERT INTO watermarks (key, ts) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts").run(key, ts);
	}

	shouldAlert(key: string, reAlertMs?: number): boolean {
		const r = this.db.query("SELECT last_alerted FROM fingerprints WHERE key = ?").get(key) as any;
		if (!r) return true;
		if (reAlertMs === undefined) return false;
		return Date.now() - Number(r.last_alerted) > reAlertMs;
	}
	markAlerted(key: string, family: string): void {
		const now = Date.now();
		this.db.query(`INSERT INTO fingerprints (key, family, first_alerted, last_alerted) VALUES (?, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET last_alerted = excluded.last_alerted`).run(key, family, now, now);
	}
	clearAlerts(prefix: string): void {
		this.db.query("DELETE FROM fingerprints WHERE key LIKE ? || '%'").run(prefix);
	}
	alertKeys(prefix: string): string[] {
		return (this.db.query("SELECT key FROM fingerprints WHERE key LIKE ? || '%' ORDER BY key").all(prefix) as any[]).map((r) => r.key);
	}

	getSnapshot(name: string): Record<string, string> | null {
		const r = this.db.query("SELECT value FROM snapshots WHERE name = ?").get(name) as any;
		return r ? JSON.parse(r.value) : null;
	}
	setSnapshot(name: string, v: Record<string, string>): void {
		this.db.query("INSERT INTO snapshots (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, JSON.stringify(v));
	}

	recordCost(date: string, usd: number): void {
		this.db.query("INSERT INTO costs (date, usd) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET usd = excluded.usd").run(date, usd);
	}
	costBaseline(excludeDate: string, days: number): number | null {
		const rows = this.db.query("SELECT usd FROM costs WHERE date < ? ORDER BY date DESC LIMIT ?").all(excludeDate, days) as any[];
		if (rows.length === 0) return null;
		return rows.reduce((a, r) => a + Number(r.usd), 0) / rows.length;
	}
	latestCost(): { date: string; usd: number } | null {
		const r = this.db.query("SELECT date, usd FROM costs ORDER BY date DESC LIMIT 1").get() as any;
		return r ? { date: r.date, usd: Number(r.usd) } : null;
	}

	journal(kind: string, payload: unknown): void {
		const now = new Date();
		this.db.query("INSERT INTO journal (ts, ts_ms, kind, payload) VALUES (?, ?, ?, ?)").run(now.toISOString(), now.getTime(), kind, JSON.stringify(payload));
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
		this.db.query("INSERT INTO unsent (target, prompt, ttl_ms, created_at) VALUES (?, ?, ?, ?)").run(target, prompt, ttlMs, new Date().toISOString());
	}
	unsent(): { id: number; target: string; prompt: string; ttl_ms: number }[] {
		return this.db.query("SELECT id, target, prompt, ttl_ms FROM unsent ORDER BY id ASC").all() as any[];
	}
	deleteUnsent(id: number): void {
		this.db.query("DELETE FROM unsent WHERE id = ?").run(id);
	}
}
```

- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(monitor): sqlite state (watermarks, fingerprints, costs, journal)`

---

### Task 8: Alarm check

**Files:**
- Create: `scripts/monitor/checks/alarms.ts`
- Test: `tests/checks-alarms.test.ts`

**Interfaces:**
- Consumes: `MonitorState` (Task 7), `Finding` (Task 6).
- Produces: `export interface AwsClient { send(cmd: any): Promise<any> }` (defined here, re-imported by other checks) and `export async function checkAlarms(client: AwsClient, state: MonitorState): Promise<Finding[]>`. Fakes route on `cmd.constructor.name`.

- [ ] **Step 1: Failing test** `tests/checks-alarms.test.ts`:

```ts
// tests/checks-alarms.test.ts
import { describe, expect, test } from "bun:test";
import { checkAlarms } from "../scripts/monitor/checks/alarms.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(alarms: { AlarmName: string; StateValue: string }[]) {
	return { send: async (_cmd: any) => ({ MetricAlarms: alarms, CompositeAlarms: [] }) };
}

describe("checkAlarms", () => {
	test("transition into ALARM is critical; still-firing does not repeat", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([{ AlarmName: "cpu-high", StateValue: "ALARM" }]);
		const first = await checkAlarms(client, state);
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("critical");
		expect(first[0].dedup_key).toBe("alarm:cpu-high:ALARM");
		const second = await checkAlarms(client, state);
		expect(second).toHaveLength(0);
	});

	test("INSUFFICIENT_DATA is warn", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkAlarms(fakeClient([{ AlarmName: "a", StateValue: "INSUFFICIENT_DATA" }]), state);
		expect(out[0].severity).toBe("warn");
	});

	test("recovery to OK ships info once, then quiet", async () => {
		const state = new MonitorState(":memory:");
		await checkAlarms(fakeClient([{ AlarmName: "cpu-high", StateValue: "ALARM" }]), state);
		const rec = await checkAlarms(fakeClient([{ AlarmName: "cpu-high", StateValue: "OK" }]), state);
		expect(rec).toHaveLength(1);
		expect(rec[0].severity).toBe("info");
		const quiet = await checkAlarms(fakeClient([{ AlarmName: "cpu-high", StateValue: "OK" }]), state);
		expect(quiet).toHaveLength(0);
	});

	test("an alarm that was always OK produces nothing", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkAlarms(fakeClient([{ AlarmName: "fine", StateValue: "OK" }]), state);
		expect(out).toHaveLength(0);
	});

	test("re-entering ALARM after recovery alerts again", async () => {
		const state = new MonitorState(":memory:");
		const alarm = (v: string) => fakeClient([{ AlarmName: "x", StateValue: v }]);
		await checkAlarms(alarm("ALARM"), state);
		await checkAlarms(alarm("OK"), state);
		const again = await checkAlarms(alarm("ALARM"), state);
		expect(again).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `scripts/monitor/checks/alarms.ts`:

```ts
// scripts/monitor/checks/alarms.ts
import { DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";

export interface AwsClient {
	send(cmd: any): Promise<any>;
}

export async function checkAlarms(client: AwsClient, state: MonitorState): Promise<Finding[]> {
	const findings: Finding[] = [];
	const resp = await client.send(new DescribeAlarmsCommand({}));
	const alarms = [...(resp.MetricAlarms ?? []), ...(resp.CompositeAlarms ?? [])];
	for (const a of alarms) {
		const name: string = a.AlarmName ?? "unknown";
		const sv: string = a.StateValue ?? "OK";
		const key = `alarm:${name}:${sv}`;
		const prefix = `alarm:${name}:`;
		if (sv === "OK") {
			const prior = state.alertKeys(prefix).filter((k) => k !== key);
			if (prior.length > 0) {
				state.clearAlerts(prefix);
				state.markAlerted(key, "alarm");
				findings.push({
					family: "alarm", severity: "info", resource: name,
					summary: `Alarm ${name} recovered to OK`,
					dedup_key: key, evidence: { state: sv, reason: a.StateReason ?? null },
					at: new Date().toISOString(),
				});
			}
			continue;
		}
		if (!state.shouldAlert(key)) continue;
		state.clearAlerts(prefix);
		state.markAlerted(key, "alarm");
		findings.push({
			family: "alarm",
			severity: sv === "ALARM" ? "critical" : "warn",
			resource: name,
			summary: `Alarm ${name} entered ${sv}`,
			dedup_key: key,
			evidence: { state: sv, reason: a.StateReason ?? null },
			at: new Date().toISOString(),
		});
	}
	return findings;
}
```

Note the OK path must not `markAlerted` an OK key when there was no prior non-OK key (test 4), and after recovery the OK key blocks repeat info findings (test 3): clearAlerts(prefix) then markAlerted(OK key) achieves both — `prior` is computed before clearing.

- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(monitor): alarm transition check`

---

### Task 9: Log error check

**Files:**
- Create: `scripts/monitor/checks/logs.ts`
- Test: `tests/checks-logs.test.ts`

**Interfaces:**
- Consumes: `AwsClient` (Task 8), `MonitorState`, `Finding`.
- Produces: `export async function checkLogs(client: AwsClient, state: MonitorState, opts?: { now?: number; reAlertMs?: number; lookbackMs?: number }): Promise<Finding[]>` and `export function logSignature(message: string): string` (normalize: strip digits, hex runs 8+, ISO timestamps; take first 120 chars; sha256 hex 12).

- [ ] **Step 1: Failing test** `tests/checks-logs.test.ts`:

```ts
// tests/checks-logs.test.ts
import { describe, expect, test } from "bun:test";
import { checkLogs, logSignature } from "../scripts/monitor/checks/logs.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(groups: string[], eventsByGroup: Record<string, { timestamp: number; message: string }[]>) {
	return {
		calls: [] as any[],
		async send(cmd: any) {
			this.calls.push(cmd);
			if (cmd.constructor.name === "DescribeLogGroupsCommand") {
				return { logGroups: groups.map((g) => ({ logGroupName: g })) };
			}
			if (cmd.constructor.name === "FilterLogEventsCommand") {
				const g = cmd.input.logGroupName as string;
				const since = cmd.input.startTime as number;
				return { events: (eventsByGroup[g] ?? []).filter((e) => e.timestamp >= since) };
			}
			throw new Error(`unexpected ${cmd.constructor.name}`);
		},
	};
}

describe("checkLogs", () => {
	test("signature is stable across ids and timestamps", () => {
		const a = logSignature("ERROR order 12345 failed at 2026-08-30T10:00:00Z req 6f9a0c2b4d1e8f37");
		const b = logSignature("ERROR order 99999 failed at 2026-08-31T11:11:11Z req deadbeefcafe0123");
		expect(a).toBe(b);
		expect(logSignature("WARN disk low")).not.toBe(a);
	});

	test("errors since the watermark become one grouped finding; watermark advances", async () => {
		const state = new MonitorState(":memory:");
		const now = 1_000_000_000_000;
		const client = fakeClient(["/aws/app"], {
			"/aws/app": [
				{ timestamp: now - 60_000, message: "ERROR db connect failed 1" },
				{ timestamp: now - 30_000, message: "ERROR db connect failed 2" },
			],
		});
		const out = await checkLogs(client, state, { now });
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		expect((out[0].evidence as any).count).toBe(2);
		expect(state.getWatermark("logs:/aws/app")).toBe(now - 30_000 + 1);
	});

	test("second run with no new events is quiet; same signature within window is deduped", async () => {
		const state = new MonitorState(":memory:");
		const now = 1_000_000_000_000;
		const events = [{ timestamp: now - 60_000, message: "ERROR x failed" }];
		await checkLogs(fakeClient(["/g"], { "/g": events }), state, { now });
		// new event, same signature, later timestamp
		const later = [{ timestamp: now + 10_000, message: "ERROR x failed" }];
		const out = await checkLogs(fakeClient(["/g"], { "/g": later }), state, { now: now + 20_000 });
		expect(out).toHaveLength(0); // fingerprinted
		expect(state.getWatermark("logs:/g")).toBe(now + 10_000 + 1);
	});

	test("first run only looks back lookbackMs", async () => {
		const state = new MonitorState(":memory:");
		const now = 1_000_000_000_000;
		const client = fakeClient(["/g"], { "/g": [{ timestamp: now - 3_600_000, message: "ERROR ancient" }] });
		const out = await checkLogs(client, state, { now, lookbackMs: 900_000 });
		expect(out).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `scripts/monitor/checks/logs.ts`:

```ts
// scripts/monitor/checks/logs.ts
import { DescribeLogGroupsCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import * as crypto from "node:crypto";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

const FILTER_PATTERN = "?ERROR ?WARN ?Exception";
const MAX_GROUPS = 50;

export function logSignature(message: string): string {
	const normalized = message
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
		.replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
		.replace(/\d+/g, "<n>")
		.slice(0, 120);
	return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export async function checkLogs(
	client: AwsClient,
	state: MonitorState,
	opts: { now?: number; reAlertMs?: number; lookbackMs?: number } = {},
): Promise<Finding[]> {
	const now = opts.now ?? Date.now();
	const reAlertMs = opts.reAlertMs ?? 86_400_000;
	const lookbackMs = opts.lookbackMs ?? 900_000;
	const findings: Finding[] = [];

	const groupsResp = await client.send(new DescribeLogGroupsCommand({ limit: MAX_GROUPS }));
	const groups: string[] = (groupsResp.logGroups ?? []).map((g: any) => g.logGroupName).filter(Boolean);

	for (const group of groups) {
		const wmKey = `logs:${group}`;
		const since = state.getWatermark(wmKey) ?? now - lookbackMs;
		const resp = await client.send(new FilterLogEventsCommand({
			logGroupName: group,
			startTime: since,
			endTime: now,
			filterPattern: FILTER_PATTERN,
		}));
		const events: { timestamp: number; message: string }[] = resp.events ?? [];
		if (events.length === 0) continue;

		let maxTs = since;
		const bySig = new Map<string, { count: number; sample: string; lastTs: number }>();
		for (const e of events) {
			if (e.timestamp > maxTs) maxTs = e.timestamp;
			const sig = logSignature(e.message ?? "");
			const cur = bySig.get(sig) ?? { count: 0, sample: (e.message ?? "").slice(0, 300), lastTs: e.timestamp };
			cur.count++;
			cur.lastTs = Math.max(cur.lastTs, e.timestamp);
			bySig.set(sig, cur);
		}
		state.setWatermark(wmKey, maxTs + 1);

		for (const [sig, agg] of bySig) {
			const key = `logs:${group}:${sig}`;
			if (!state.shouldAlert(key, reAlertMs)) continue;
			state.markAlerted(key, "logs");
			findings.push({
				family: "logs", severity: "warn", resource: group,
				summary: `${agg.count} error-pattern event(s) in ${group}`,
				dedup_key: key,
				evidence: { count: agg.count, sample: agg.sample, signature: sig },
				at: new Date(now).toISOString(),
			});
		}
	}
	return findings;
}
```

- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(monitor): log error scan with watermarks and signature dedup`

---

### Task 10: Drift/health check

**Files:**
- Create: `scripts/monitor/checks/drift.ts`
- Test: `tests/checks-drift.test.ts`

**Interfaces:**
- Consumes: `AwsClient`, `MonitorState`, `Finding`.
- Produces: `export async function checkDrift(client: AwsClient, state: MonitorState): Promise<Finding[]>`. Snapshot name `"instances"`, values `Record<instanceId, state>`.

- [ ] **Step 1: Failing test** `tests/checks-drift.test.ts`:

```ts
// tests/checks-drift.test.ts
import { describe, expect, test } from "bun:test";
import { checkDrift } from "../scripts/monitor/checks/drift.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(
	instances: { id: string; state: string }[],
	statuses: { id: string; system: string; instance: string }[] = [],
) {
	return {
		async send(cmd: any) {
			if (cmd.constructor.name === "DescribeInstancesCommand") {
				return { Reservations: [{ Instances: instances.map((i) => ({ InstanceId: i.id, State: { Name: i.state } })) }] };
			}
			if (cmd.constructor.name === "DescribeInstanceStatusCommand") {
				return { InstanceStatuses: statuses.map((s) => ({
					InstanceId: s.id,
					SystemStatus: { Status: s.system },
					InstanceStatus: { Status: s.instance },
				})) };
			}
			throw new Error(`unexpected ${cmd.constructor.name}`);
		},
	};
}

describe("checkDrift", () => {
	test("first run establishes the baseline silently", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state);
		expect(out).toHaveLength(0);
		expect(state.getSnapshot("instances")).toEqual({ "i-1": "running" });
	});

	test("running to stopped is warn, once", async () => {
		const state = new MonitorState(":memory:");
		await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state);
		const out = await checkDrift(fakeClient([{ id: "i-1", state: "stopped" }]), state);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		const again = await checkDrift(fakeClient([{ id: "i-1", state: "stopped" }]), state);
		expect(again).toHaveLength(0);
	});

	test("disappeared instance is warn; new instance is info", async () => {
		const state = new MonitorState(":memory:");
		await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state);
		const out = await checkDrift(fakeClient([{ id: "i-2", state: "running" }]), state);
		const sevs = out.map((f) => `${f.resource}:${f.severity}`).sort();
		expect(sevs).toEqual(["i-1:warn", "i-2:info"]);
	});

	test("failed status check is warn once and clears on recovery", async () => {
		const state = new MonitorState(":memory:");
		const bad = fakeClient([{ id: "i-1", state: "running" }], [{ id: "i-1", system: "impaired", instance: "ok" }]);
		await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state); // baseline
		const out = await checkDrift(bad, state);
		expect(out).toHaveLength(1);
		expect(out[0].summary).toContain("status check");
		expect((await checkDrift(bad, state))).toHaveLength(0);
		const good = fakeClient([{ id: "i-1", state: "running" }], [{ id: "i-1", system: "ok", instance: "ok" }]);
		await checkDrift(good, state);
		const badAgain = await checkDrift(bad, state);
		expect(badAgain).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `scripts/monitor/checks/drift.ts`:

```ts
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

	const prev = state.getSnapshot("instances");
	if (prev !== null) {
		for (const [id, st] of Object.entries(current)) {
			const was = prev[id];
			if (was === undefined) {
				findings.push({ family: "drift", severity: "info", resource: id, summary: `New instance ${id} (${st})`, dedup_key: `drift:${id}:new`, evidence: { state: st }, at: now });
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
				findings.push({ family: "drift", severity: "warn", resource: id, summary: `Instance ${id} disappeared (was ${prev[id]})`, dedup_key: `drift:${id}:gone`, evidence: { was: prev[id] }, at: now });
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
			family: "drift", severity: "warn", resource: id,
			summary: `Instance ${id} failing status check (system=${sys} instance=${inst})`,
			dedup_key: key, evidence: { system: sys, instance: inst }, at: now,
		});
	}
	// Recovery: clear fingerprints for instances no longer failing.
	for (const key of state.alertKeys("drift:")) {
		const m = key.match(/^drift:(.+):statuscheck$/);
		if (m && !failedNow.has(m[1])) state.clearAlerts(key);
	}
	return findings;
}
```

Note: the drift state-change findings need no fingerprints (the snapshot diff is edge-triggered), so `dedup_key` is informational there. The test "warn, once" passes because the second run diffs stopped==stopped.

- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(monitor): instance drift and status check detection`

---

### Task 11: Cost anomaly check

**Files:**
- Create: `scripts/monitor/checks/cost.ts`
- Test: `tests/checks-cost.test.ts`

**Interfaces:**
- Consumes: `AwsClient`, `MonitorState`, `Finding`.
- Produces: `export async function checkCost(client: AwsClient, state: MonitorState, opts?: { now?: Date; pct?: number; abs?: number }): Promise<Finding[]>` (defaults pct 20, abs 1).

- [ ] **Step 1: Failing test** `tests/checks-cost.test.ts`:

```ts
// tests/checks-cost.test.ts
import { describe, expect, test } from "bun:test";
import { checkCost } from "../scripts/monitor/checks/cost.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(daily: { date: string; usd: number }[]) {
	return {
		async send(cmd: any) {
			if (cmd.constructor.name !== "GetCostAndUsageCommand") throw new Error("unexpected");
			return {
				ResultsByTime: daily.map((d) => ({
					TimePeriod: { Start: d.date },
					Total: { UnblendedCost: { Amount: String(d.usd), Unit: "USD" } },
				})),
			};
		},
	};
}

// now = 2026-08-30 anywhere in the day; yesterday = 2026-08-29
const NOW = new Date("2026-08-30T08:00:00Z");
function days(baseline: number, yesterday: number) {
	const out: { date: string; usd: number }[] = [];
	for (let d = 15; d >= 2; d--) {
		const dt = new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);
		out.push({ date: dt, usd: baseline });
	}
	out.push({ date: "2026-08-29", usd: yesterday });
	return out;
}

describe("checkCost", () => {
	test("over both thresholds alerts once per day", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient(days(10, 13)); // +30 pct and +3 usd
		const out = await checkCost(client, state, { now: NOW });
		expect(out).toHaveLength(1);
		expect(out[0].dedup_key).toBe("cost:2026-08-29");
		expect((await checkCost(client, state, { now: NOW }))).toHaveLength(0);
	});

	test("over pct but under abs stays quiet", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(fakeClient(days(1, 1.5)), state, { now: NOW }); // +50 pct, +0.50 usd
		expect(out).toHaveLength(0);
	});

	test("over abs but under pct stays quiet", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(fakeClient(days(100, 110)), state, { now: NOW }); // +10 usd, +10 pct
		expect(out).toHaveLength(0);
	});

	test("no baseline yet stays quiet but records costs", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(fakeClient([{ date: "2026-08-29", usd: 5 }]), state, { now: NOW });
		expect(out).toHaveLength(0);
		expect(state.latestCost()).toEqual({ date: "2026-08-29", usd: 5 });
	});
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `scripts/monitor/checks/cost.ts`:

```ts
// scripts/monitor/checks/cost.ts
import { GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import type { Finding } from "../report.ts";
import type { MonitorState } from "../state.ts";
import type { AwsClient } from "./alarms.ts";

export async function checkCost(
	client: AwsClient,
	state: MonitorState,
	opts: { now?: Date; pct?: number; abs?: number } = {},
): Promise<Finding[]> {
	const now = opts.now ?? new Date();
	const pct = opts.pct ?? 20;
	const abs = opts.abs ?? 1;

	const end = now.toISOString().slice(0, 10); // exclusive
	const start = new Date(now.getTime() - 15 * 86_400_000).toISOString().slice(0, 10);
	const resp = await client.send(new GetCostAndUsageCommand({
		TimePeriod: { Start: start, End: end },
		Granularity: "DAILY",
		Metrics: ["UnblendedCost"],
	}));

	for (const r of resp.ResultsByTime ?? []) {
		const date = r.TimePeriod?.Start;
		const amount = Number(r.Total?.UnblendedCost?.Amount ?? "0");
		if (date) state.recordCost(date, amount);
	}

	const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
	const latest = state.latestCost();
	if (!latest || latest.date !== yesterday) return [];
	const baseline = state.costBaseline(yesterday, 14);
	if (baseline === null) return [];

	const overPct = latest.usd > baseline * (1 + pct / 100);
	const overAbs = latest.usd > baseline + abs;
	if (!(overPct && overAbs)) return [];

	const key = `cost:${yesterday}`;
	if (!state.shouldAlert(key)) return [];
	state.markAlerted(key, "cost");
	return [{
		family: "cost", severity: "warn", resource: "account",
		summary: `Spend ${yesterday} was $${latest.usd.toFixed(2)} vs 14d baseline $${baseline.toFixed(2)} (+${((latest.usd / baseline - 1) * 100).toFixed(0)} pct)`,
		dedup_key: key,
		evidence: { date: yesterday, usd: latest.usd, baseline },
		at: now.toISOString(),
	}];
}
```

Note test "no baseline yet": with a single recorded day (yesterday), `costBaseline` returns null — quiet. Correct.

- [ ] **Step 4: Run — PASS. Step 5: Commit** `feat(monitor): daily cost anomaly check with double threshold`

---

### Task 12: Monitor coms-net client

**Files:**
- Create: `scripts/monitor/coms.ts`
- Test: `tests/monitor-coms.integration.test.ts`

**Interfaces:**
- Consumes: the hub protocol (register/heartbeat/SSE/messages) as implemented in `scripts/coms-net-server.ts`; the mailbox from Tasks 2-3.
- Produces:

```ts
export type InboundPrompt = { msg_id: string; sender_name: string; prompt: string; response_schema: object | null };
export class MonitorComs {
	constructor(opts: {
		serverUrl: string; token: string; project: string; name: string; purpose: string;
		onPrompt: (p: InboundPrompt) => Promise<string>;
	});
	async start(): Promise<void>;   // register + SSE loop + heartbeat; throws if register fails
	async stop(): Promise<void>;
	get name(): string;             // server-assigned (may be suffixed)
	async send(target: string, prompt: string, opts?: { ttl_ms?: number; response_schema?: object }): Promise<{ msg_id: string; status: string }>;
	async awaitReply(msg_id: string, timeoutMs: number): Promise<{ response?: any; error?: string | null }>;
}
```

- [ ] **Step 1: Failing integration test** `tests/monitor-coms.integration.test.ts` (reuse the hub-spawning harness pattern from `tests/mailbox.integration.test.ts` — copy `startHub`/`stopHub`/`TOKEN` into this file, or extract them to `tests/harness.ts` first and update the mailbox test imports):

```ts
// tests/monitor-coms.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { MonitorComs } from "../scripts/monitor/coms.ts";
import { startHub, stopHub, TOKEN, activeHubs } from "./harness.ts";

afterEach(async () => { while (activeHubs.length) await stopHub(activeHubs.pop()!); });

describe("MonitorComs", () => {
	test("registers, sends with ttl, and answers inbound prompts", async () => {
		const hub = await startHub();
		const agent = new MonitorComs({
			serverUrl: hub.url, token: TOKEN, project: "default",
			name: "monitor-aws-123", purpose: "test monitor",
			onPrompt: async (p) => `pong:${p.prompt}`,
		});
		await agent.start();

		const peer = new MonitorComs({
			serverUrl: hub.url, token: TOKEN, project: "default",
			name: "laptop", purpose: "test operator",
			onPrompt: async () => "ok",
		});
		await peer.start();

		// send + await round trip (peer answers via onPrompt)
		const sent = await agent.send("laptop", "ping", { ttl_ms: 86_400_000 });
		expect(sent.msg_id).toBeTruthy();
		const reply = await peer.send("monitor-aws-123", "run-checks");
		const answer = await peer.awaitReply(reply.msg_id, 10_000);
		expect(answer.error ?? null).toBeNull();
		expect(answer.response).toBe("pong:run-checks");

		await agent.stop();
		await peer.stop();
	});

	test("long-ttl send to an offline name queues", async () => {
		const hub = await startHub();
		const agent = new MonitorComs({
			serverUrl: hub.url, token: TOKEN, project: "default",
			name: "monitor-aws-123", purpose: "t", onPrompt: async () => "",
		});
		await agent.start();
		const sent = await agent.send("nobody-home", "report", { ttl_ms: 86_400_000 });
		expect(sent.status).toBe("queued");
		await agent.stop();
	});
});
```

`tests/harness.ts` exports `TOKEN`, `startHub(home?)`, `stopHub(hub)`, `activeHubs` (the array), plus `api`, `register`, `send`, `readSseEvents` — move the existing helpers from `tests/mailbox.integration.test.ts` verbatim and re-import them there.

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `scripts/monitor/coms.ts`. Shape (mirror the extension's HTTP/SSE code, minus Pi/TUI):

```ts
// scripts/monitor/coms.ts
import * as crypto from "node:crypto";

export type InboundPrompt = { msg_id: string; sender_name: string; prompt: string; response_schema: object | null };

type Opts = {
	serverUrl: string; token: string; project: string; name: string; purpose: string;
	onPrompt: (p: InboundPrompt) => Promise<string>;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(): string { /* verbatim from scripts/coms-net-server.ts lines 266-287 */ }

export class MonitorComs {
	private opts: Opts;
	private sessionId = ulid();
	private assignedName: string;
	private sseUrl: string | null = null;
	private sseAbort: AbortController | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;
	private pending = new Map<string, { promise: Promise<{ response?: any; error?: string | null }>; resolve: (v: any) => void; result?: any }>();

	constructor(opts: Opts) { this.opts = opts; this.assignedName = opts.name; }
	get name(): string { return this.assignedName; }

	private async http(method: string, p: string, body?: unknown): Promise<any> {
		const resp = await fetch(this.opts.serverUrl + p, {
			method,
			headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await resp.text();
		const parsed = text ? JSON.parse(text) : null;
		if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status} ${method} ${p}: ${parsed?.error ?? text}`), { status: resp.status, body: parsed });
		return parsed;
	}

	async start(): Promise<void> {
		const reg = await this.http("POST", "/v1/agents/register", {
			project: this.opts.project, session_id: this.sessionId, name: this.opts.name,
			purpose: this.opts.purpose, model: "none", color: "#5599DD",
			cwd: process.cwd(), explicit: true,
		});
		this.assignedName = reg.agent.name;
		this.sseUrl = reg.sse_url;
		void this.sseLoop();
		this.heartbeatTimer = setInterval(() => {
			this.http("POST", `/v1/agents/${encodeURIComponent(this.sessionId)}/heartbeat`, {
				project: this.opts.project, context_used_pct: 0, queue_depth: 0, status: "online",
			}).catch(() => { /* transient */ });
		}, reg.heartbeat_interval_ms ?? 10_000);
		this.heartbeatTimer.unref?.();
	}

	private async sseLoop(): Promise<void> {
		while (!this.stopped) {
			const ac = new AbortController();
			this.sseAbort = ac;
			try {
				const resp = await fetch(this.opts.serverUrl + this.sseUrl, {
					headers: { authorization: `Bearer ${this.opts.token}`, accept: "text/event-stream" },
					signal: ac.signal,
				});
				if (!resp.ok || !resp.body) throw new Error(`sse http ${resp.status}`);
				const reader = resp.body.getReader();
				const dec = new TextDecoder();
				let buf = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					let idx: number;
					while ((idx = buf.indexOf("\n\n")) >= 0) {
						const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
						this.handleFrame(frame);
					}
				}
			} catch {
				if (this.stopped) return;
			}
			if (this.stopped) return;
			await Bun.sleep(2_000);
			// re-register: session may have been reaped while disconnected
			try { await this.reRegister(); } catch { /* retry next loop */ }
		}
	}

	private async reRegister(): Promise<void> {
		const reg = await this.http("POST", "/v1/agents/register", {
			project: this.opts.project, session_id: this.sessionId, name: this.assignedName,
			purpose: this.opts.purpose, model: "none", color: "#5599DD", cwd: process.cwd(), explicit: true,
		});
		this.sseUrl = reg.sse_url;
	}

	private handleFrame(frame: string): void {
		let event = "message"; let data = "";
		for (const line of frame.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data = line.slice(5).trim();
		}
		if (!data) return;
		let payload: any;
		try { payload = JSON.parse(data); } catch { return; }
		if (event === "prompt") {
			const p: InboundPrompt = {
				msg_id: payload.msg_id,
				sender_name: payload.sender?.name ?? "unknown",
				prompt: payload.prompt ?? "",
				response_schema: payload.response_schema ?? null,
			};
			void this.answer(p);
		} else if (event === "response") {
			const pend = this.pending.get(payload.msg_id);
			if (pend) {
				pend.result = { response: payload.response, error: payload.error ?? null };
				pend.resolve(pend.result);
			}
		}
	}

	private async answer(p: InboundPrompt): Promise<void> {
		let response = "";
		let error: string | null = null;
		try { response = await this.opts.onPrompt(p); } catch (e: any) { error = String(e?.message ?? e); }
		try {
			await this.http("POST", `/v1/messages/${encodeURIComponent(p.msg_id)}/response`, {
				project: this.opts.project, responder_session: this.sessionId,
				response: error ? null : response, error,
			});
		} catch { /* message may have expired */ }
	}

	async send(target: string, prompt: string, opts: { ttl_ms?: number; response_schema?: object } = {}): Promise<{ msg_id: string; status: string }> {
		const resp = await this.http("POST", "/v1/messages", {
			project: this.opts.project, sender_session: this.sessionId, target,
			target_session: null, prompt, conversation_id: null,
			response_schema: opts.response_schema ?? null, hops: 0,
			...(opts.ttl_ms ? { ttl_ms: opts.ttl_ms } : {}),
		});
		let resolve!: (v: any) => void;
		const promise = new Promise<{ response?: any; error?: string | null }>((res) => { resolve = res; });
		this.pending.set(resp.msg_id, { promise, resolve });
		return { msg_id: resp.msg_id, status: resp.status };
	}

	async awaitReply(msg_id: string, timeoutMs: number): Promise<{ response?: any; error?: string | null }> {
		const pend = this.pending.get(msg_id);
		if (pend?.result) return pend.result;
		const local = pend ? pend.promise : new Promise<never>(() => {});
		const timeout = Bun.sleep(timeoutMs).then(() => ({ error: "timeout" as const }));
		const winner = await Promise.race([local, timeout]);
		this.pending.delete(msg_id);
		return winner as any;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.sseAbort?.abort();
		try {
			await this.http("DELETE", `/v1/agents/${encodeURIComponent(this.sessionId)}?project=${encodeURIComponent(this.opts.project)}`);
		} catch { /* hub may be gone */ }
	}
}
```

(Fill the `ulid()` body verbatim from the server file.)

- [ ] **Step 4: Run — PASS** (`bun test tests/monitor-coms.integration.test.ts tests/mailbox.integration.test.ts` — the harness extraction must not break the mailbox tests). **Step 5: Commit** `feat(monitor): headless coms-net client`

---

### Task 13: Monitor entrypoint — cycle, cron, commands

**Files:**
- Create: `scripts/coms-net-monitor.ts`
- Test: `tests/monitor-cycle.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `export async function runCycle(deps: CycleDeps): Promise<{ findings: Finding[] }>` and `export function makeGuard(): (fn: () => Promise<void>) => Promise<void>` exported from `scripts/coms-net-monitor.ts` for testing; `main()` guarded by `import.meta.main`.

```ts
export type CycleDeps = {
	checks: { name: string; run: () => Promise<Finding[]> }[];
	state: MonitorState;
	investigate: ((findings: Finding[], priorContext: string) => Promise<Map<string, Diagnosis> | null>) | null;
	report: (text: string) => Promise<void>; // throws on failure
	log: (line: string) => void;
};
```

- [ ] **Step 1: Failing test** `tests/monitor-cycle.test.ts`:

```ts
// tests/monitor-cycle.test.ts
import { describe, expect, test } from "bun:test";
import { makeGuard, runCycle, type CycleDeps } from "../scripts/coms-net-monitor.ts";
import type { Finding } from "../scripts/monitor/report.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const F = (over: Partial<Finding> = {}): Finding => ({
	family: "alarm", severity: "critical", resource: "cpu", summary: "alarm fired",
	dedup_key: "alarm:cpu:ALARM", evidence: {}, at: new Date().toISOString(), ...over,
});

function deps(over: Partial<CycleDeps> = {}): CycleDeps & { sent: string[] } {
	const sent: string[] = [];
	return {
		sent,
		checks: [{ name: "alarms", run: async () => [F()] }],
		state: new MonitorState(":memory:"),
		investigate: async () => new Map([["alarm:cpu:ALARM", { probable_cause: "load", affected_resources: [], suggested_action: "scale" }]]),
		report: async (text: string) => { sent.push(text); },
		log: () => {},
		...over,
	};
}

describe("runCycle", () => {
	test("findings are investigated, reported, and journaled", async () => {
		const d = deps();
		const out = await runCycle(d);
		expect(out.findings).toHaveLength(1);
		expect(d.sent).toHaveLength(1);
		expect(d.sent[0]).toContain("load");
		expect(d.state.journalRows(60_000, "finding")).toHaveLength(1);
	});

	test("investigation failure still ships the raw finding", async () => {
		const d = deps({ investigate: async () => null });
		await runCycle(d);
		expect(d.sent[0]).toContain("uninvestigated");
	});

	test("info-only findings skip investigation but still report", async () => {
		let investigated = false;
		const d = deps({
			checks: [{ name: "alarms", run: async () => [F({ severity: "info", dedup_key: "alarm:cpu:OK" })] }],
			investigate: async () => { investigated = true; return new Map(); },
		});
		await runCycle(d);
		expect(investigated).toBe(false);
		expect(d.sent).toHaveLength(1);
	});

	test("a throwing check is journaled and the rest still run", async () => {
		const d = deps({
			checks: [
				{ name: "boom", run: async () => { throw new Error("throttled"); } },
				{ name: "alarms", run: async () => [F()] },
			],
		});
		const out = await runCycle(d);
		expect(out.findings).toHaveLength(1);
		expect(d.state.journalRows(60_000, "check_error")).toHaveLength(1);
	});

	test("failed report is queued unsent and retried next cycle", async () => {
		let fail = true;
		const sent: string[] = [];
		const d = deps({
			report: async (text: string) => { if (fail) throw new Error("hub down"); sent.push(text); },
		});
		await runCycle(d);
		expect(d.state.unsent()).toHaveLength(1);
		fail = false;
		// no findings this cycle; retry path only
		d.checks = [{ name: "alarms", run: async () => [] }];
		await runCycle(d);
		expect(sent).toHaveLength(1);
		expect(d.state.unsent()).toHaveLength(0);
	});

	test("quiet cycle sends nothing", async () => {
		const d = deps({ checks: [{ name: "alarms", run: async () => [] }] });
		await runCycle(d);
		expect(d.sent).toHaveLength(0);
	});
});

describe("makeGuard", () => {
	test("overlapping invocations are skipped, not queued", async () => {
		const guard = makeGuard();
		let running = 0;
		let ran = 0;
		const slow = async () => { running++; ran++; expect(running).toBe(1); await Bun.sleep(50); running--; };
		await Promise.all([guard(slow), guard(slow), guard(slow)]);
		expect(ran).toBe(1);
	});
});
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `scripts/coms-net-monitor.ts`:

```ts
// scripts/coms-net-monitor.ts
//
// Per-host AWS account monitor. Deterministic scheduled checks (zero tokens
// when quiet); findings warn+ are investigated by the account's Pi agent over
// coms-net; reports mail to the operator via the hub mailbox with a long TTL.
// Run as pi-monitor.service; state in ~/.pi/monitor/state.db.

import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
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
	DIAGNOSIS_RESPONSE_SCHEMA, type Diagnosis, type Finding,
	formatDigest, formatIncidentReport, parseDiagnoses,
} from "./monitor/report.ts";
import { MonitorState } from "./monitor/state.ts";

// Env-with-defaults configuration
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? "unknown";
const MONITOR_NAME = process.env.PI_MONITOR_NAME ?? `monitor-aws-${ACCOUNT_ID}`;
const REPORT_TO = process.env.PI_MONITOR_REPORT_TO ?? "laptop";
const REPORT_TTL_MS = Number(process.env.PI_MONITOR_REPORT_TTL_MS ?? 604_800_000);
const CHECK_CRON = process.env.PI_MONITOR_CHECK_CRON ?? "*/15 * * * *";
const DAILY_CRON = process.env.PI_MONITOR_DAILY_CRON ?? "@daily";
const INVESTIGATE_TARGET = process.env.PI_MONITOR_INVESTIGATE_TARGET ?? `aws-${ACCOUNT_ID}`;
const INVESTIGATE_TIMEOUT_MS = Number(process.env.PI_MONITOR_INVESTIGATE_TIMEOUT_MS ?? 300_000);
const COST_PCT = Number(process.env.PI_MONITOR_COST_PCT ?? 20);
const COST_ABS = Number(process.env.PI_MONITOR_COST_ABS ?? 1);
const STATE_DB = process.env.PI_MONITOR_STATE_DB ?? path.join(os.homedir(), ".pi", "monitor", "state.db");

export type CycleDeps = {
	checks: { name: string; run: () => Promise<Finding[]> }[];
	state: MonitorState;
	investigate: ((findings: Finding[], priorContext: string) => Promise<Map<string, Diagnosis> | null>) | null;
	report: (text: string) => Promise<void>;
	log: (line: string) => void;
};

export async function runCycle(deps: CycleDeps): Promise<{ findings: Finding[] }> {
	const findings: Finding[] = [];
	for (const c of deps.checks) {
		try {
			findings.push(...await c.run());
		} catch (e: any) {
			deps.state.journal("check_error", { check: c.name, error: String(e?.message ?? e) });
			deps.log(`check ${c.name} failed: ${e?.message ?? e}`);
		}
	}

	if (findings.length > 0) {
		const toInvestigate = findings.filter((f) => f.severity !== "info");
		let diagnoses: Map<string, Diagnosis> | null = null;
		if (toInvestigate.length > 0 && deps.investigate) {
			const prior = toInvestigate
				.flatMap((f) => deps.state.priorIncidents(f.resource, 3))
				.map((r) => `${r.ts}: ${r.payload}`)
				.join("\n");
			try {
				diagnoses = await deps.investigate(toInvestigate, prior);
			} catch {
				diagnoses = null;
			}
		}
		for (const f of findings) {
			deps.state.journal("finding", { ...f, diagnosis: diagnoses?.get(f.dedup_key) ?? null });
		}
		const text = formatIncidentReport(ACCOUNT_ID, findings.map((f) => ({
			finding: f, diagnosis: diagnoses?.get(f.dedup_key) ?? null,
		})));
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

export function makeGuard(): (fn: () => Promise<void>) => Promise<void> {
	let running = false;
	return async (fn) => {
		if (running) return;
		running = true;
		try { await fn(); } finally { running = false; }
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

	const coms = new MonitorComs({
		serverUrl: process.env.PI_COMS_NET_SERVER_URL ?? "http://127.0.0.1:8787",
		token: process.env.PI_COMS_NET_AUTH_TOKEN ?? "",
		project: process.env.PI_COMS_NET_PROJECT ?? process.env.COMS_PROJECT ?? "default",
		name: MONITOR_NAME,
		purpose: `Deterministic AWS monitor for account ${ACCOUNT_ID}`,
		onPrompt: async (p) => handleCommand(p.prompt),
	});

	const investigate = async (findings: Finding[], prior: string): Promise<Map<string, Diagnosis> | null> => {
		const prompt = [
			`You are the read-only devops agent for AWS account ${ACCOUNT_ID}. The account monitor detected these findings; investigate with your AWS tools and diagnose each one.`,
			"Reply ONLY with JSON matching the response schema: an object {\"diagnoses\": [...]} with one entry per dedup_key.",
			"",
			"Findings:",
			JSON.stringify(findings, null, 2),
			prior ? `\nPrior incidents from the monitor journal:\n${prior}` : "",
		].join("\n");
		try {
			const sent = await coms.send(INVESTIGATE_TARGET, prompt, { response_schema: DIAGNOSIS_RESPONSE_SCHEMA });
			const reply = await coms.awaitReply(sent.msg_id, INVESTIGATE_TIMEOUT_MS);
			if (reply.error || reply.response == null) return null;
			return parseDiagnoses(reply.response);
		} catch {
			return null;
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
		state, investigate, report, log,
	};

	const dailyDigest = async (): Promise<void> => {
		const costDeps: CycleDeps = {
			checks: [{ name: "cost", run: () => checkCost(ce, state, { pct: COST_PCT, abs: COST_ABS }) }],
			state, investigate, report, log,
		};
		await runCycle(costDeps);
		const text = await buildDigest();
		try {
			await report(text);
		} catch (e: any) {
			state.queueUnsent(REPORT_TO, text, REPORT_TTL_MS);
			log(`digest send failed, queued: ${e?.message ?? e}`);
		}
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
			const { DescribeAlarmsCommand } = await import("@aws-sdk/client-cloudwatch");
			const resp = await cw.send(new DescribeAlarmsCommand({ StateValue: "ALARM" }));
			activeAlarms = (resp.MetricAlarms ?? []).map((a: any) => a.AlarmName);
		} catch { /* digest still ships */ }
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

	const guard = makeGuard();
	const runChecksNow = () => guard(async () => { await runCycle(fifteenDeps); });

	const handleCommand = async (prompt: string): Promise<string> => {
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
			return rows.length === 0 ? "no findings in the last 7 days" : rows.map((r) => `${r.ts} ${r.payload}`).join("\n");
		}
		return "unknown command. available: run-checks, status, digest, history";
	};

	void (async () => {
		await coms.start();
		log(`registered as ${coms.name}; checks ${CHECK_CRON}; daily ${DAILY_CRON}; reporting to ${REPORT_TO}`);
		Bun.cron(CHECK_CRON, () => runChecksNow());
		Bun.cron(DAILY_CRON, () => guard(dailyDigest));
	})();

	const shutdown = () => { void coms.stop().finally(() => process.exit(0)); };
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
	main();
}
```

Note `handleCommand` is referenced by the `coms` constructor before its declaration — declare `handleCommand` with `let`/hoisted `const` ordering issue: define `let handleCommand: (p: string) => Promise<string>` above the `coms` construction and assign later, with the constructor closure calling `handleCommand(p.prompt)`. Implement that way.

- [ ] **Step 4: Run — full suite + syntax check**

```bash
bun test
bun build scripts/coms-net-monitor.ts --external '*' --outfile /dev/null
```

- [ ] **Step 5: Commit** `feat(monitor): monitor entrypoint with Bun.cron scheduling and coms commands`

---

### Task 14: Deploy wiring

**Files:**
- Modify: `deploy/modules/agent/main.tf` (after the `agent_cloudwatch_read` policy, line ~128)
- Modify: `deploy/bootstrap/agent-bootstrap.sh` (units section, line ~194)

- [ ] **Step 1: Terraform — Cost Explorer read**

Add after `aws_iam_role_policy.agent_cloudwatch_read`:

```hcl
// The monitor's daily cost check. Cost Explorer has no resource-level scoping.
resource "aws_iam_role_policy" "agent_cost_read" {
  name = "cost-explorer-read"
  role = aws_iam_role.agent.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ce:GetCostAndUsage"]
      Resource = "*"
    }]
  })
}
```

- [ ] **Step 2: Bootstrap — pi-monitor.service**

In `deploy/bootstrap/agent-bootstrap.sh`, after the `pi-agent.service` heredoc (before the `sudo -u ... mkdir -p "$AGENT_HOME/bin"` line), add:

```bash
# The account monitor: deterministic scheduled checks, reports via the hub
# mailbox. Independent of pi-agent.service by design -- a wedged agent never
# stops detection.
cat > /etc/systemd/system/pi-monitor.service <<UNIT
[Unit]
Description=Pi AWS account monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$AGENT_USER
WorkingDirectory=$AGENT_HOME/pi-coms
Environment=HOME=$AGENT_HOME
ExecStart=/bin/bash -c 'source \$HOME/.coms-env && exec \$HOME/.bun/bin/bun scripts/coms-net-monitor.ts'
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
```

and extend the enable block at the bottom:

```bash
systemctl enable --now herdr.service
systemctl enable pi-agent.service
systemctl restart pi-agent.service
systemctl enable pi-monitor.service
systemctl restart pi-monitor.service
```

(Note: `\$HOME` escapes matter — the outer heredoc is unquoted so `$AGENT_USER`/`$AGENT_HOME` expand at bootstrap time while `\$HOME` survives into the unit.)

- [ ] **Step 3: Verify**

```bash
bash -n deploy/bootstrap/agent-bootstrap.sh
terraform -chdir=deploy/modules/agent fmt -check
terraform -chdir=deploy/modules/agent validate 2>/dev/null || echo "validate needs init; fmt+manual review is the gate"
```

- [ ] **Step 4: Commit** `feat(deploy): pi-monitor.service and Cost Explorer read grant`

---

### Task 15: Full verification + PR

- [ ] **Step 1: Full suite and syntax checks**

```bash
bun test
bun build scripts/coms-net-server.ts --external '*' --outfile /dev/null
bun build extensions/coms-net.ts --external '*' --outfile /dev/null
bun build scripts/coms-net-monitor.ts --external '*' --outfile /dev/null
```

- [ ] **Step 2: Spec acceptance sweep** — re-read the acceptance criteria in SIO-1575 against the test list; every criterion except the manual poc E2E must map to a passing test.

- [ ] **Step 3: Push and open a PR** against `main` (base may need to wait on `fix/poc-subnet-passthrough` merging; if that branch is unmerged, open the PR with it as base). Use superpowers:finishing-a-development-branch.

**Manual E2E (operator-run, poc account, after merge+deploy):** force one finding per family — create a test alarm with a 1-datapoint threshold and breach it; log an `ERROR` line into a watched group; stop a scratch instance; verify the incident reports and next digest arrive in the operator's session via mailbox delivery, and that `run-checks`, `status`, `digest`, `history` answer over coms.

## Self-Review Notes

- Spec coverage: mailbox storage/flush/recovery/TTLs/name-delivery/cleanup/container (Tasks 1-4), client pass-through (Task 5), monitor schedules/identity/state/checks/finding/investigation/reports (Tasks 6-13), IAM + service install (Task 14), testing strategy items 1-4 (unit: checks/state; integration: mailbox + coms client; scheduling: `makeGuard` + Bun's own no-overlap guarantee — native cron firing is not fake-timer-testable, so the guard logic is what we test), manual E2E deferred to operators (spec testing item 5).
- The spec's "fake timers drive Bun.cron" is replaced by guard-logic tests: `Bun.cron` is a native scheduler that `setSystemTime` does not drive; Bun documents the no-overlap guarantee per job, and cross-source overlap (cron + run-checks command) is what `makeGuard` covers.
- Dependency additions to package.json (zod + 4 AWS SDK clients) are required by the spec's monitor design; agent hosts already run `bun install` at bootstrap. Flag to the user in the final summary.
