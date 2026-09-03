// tests/inbox.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MailStore, type ComsMessage } from "../scripts/coms-net-server.ts";

const tmpDirs: string[] = [];
afterAll(() => {
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-"));
	tmpDirs.push(dir);
	return path.join(dir, "messages.db");
}

let seq = 0;
function msg(over: Partial<ComsMessage> = {}): ComsMessage {
	// msg_id must sort by creation order like real ULIDs do
	seq += 1;
	return {
		msg_id: over.msg_id ?? `01TEST${String(seq).padStart(20, "0")}`,
		project: "default",
		sender_session: "S1",
		sender_name: "monitor",
		sender_cwd: "/tmp",
		target_session: null,
		target_name: "ops",
		prompt: "report",
		conversation_id: null,
		response_schema: null,
		hops: 0,
		status: "queued",
		mailbox: true,
		response: null,
		error: null,
		created_at: new Date().toISOString(),
		expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		...over,
	};
}

describe("MailStore inbox", () => {
	test("returns messages for a name ascending, newest window without since", () => {
		const store = new MailStore(tmpDb());
		for (let i = 1; i <= 5; i++) store.upsert(msg({ prompt: `r${i}` }));
		store.upsert(msg({ target_name: "other", prompt: "not-ops" }));
		const all = store.inbox("ops", 10);
		expect(all.map((m) => m.prompt)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
		const last3 = store.inbox("ops", 3);
		expect(last3.map((m) => m.prompt)).toEqual(["r3", "r4", "r5"]);
		store.close();
	});

	test("since cursor returns only newer messages, ascending", () => {
		const store = new MailStore(tmpDb());
		const a = msg({ prompt: "a" });
		const b = msg({ prompt: "b" });
		const c = msg({ prompt: "c" });
		for (const m of [a, b, c]) store.upsert(m);
		const after = store.inbox("ops", 10, a.msg_id);
		expect(after.map((m) => m.prompt)).toEqual(["b", "c"]);
		store.close();
	});

	test("terminal mailbox rows are listed; purgeExpired removes only past-expiry rows", () => {
		const store = new MailStore(tmpDb());
		store.upsert(msg({ prompt: "done", status: "complete", completed_at: new Date().toISOString() }));
		store.upsert(msg({
			prompt: "old",
			status: "complete",
			expires_at: new Date(Date.now() - 1_000).toISOString(),
		}));
		store.upsert(msg({ prompt: "live" }));
		expect(store.inbox("ops", 10).map((m) => m.prompt)).toEqual(["done", "old", "live"]);
		store.purgeExpired();
		expect(store.inbox("ops", 10).map((m) => m.prompt)).toEqual(["done", "live"]);
		store.close();
	});

	test("purgeExpired leaves non-terminal rows to the live sweep", () => {
		const store = new MailStore(tmpDb());
		store.upsert(msg({
			prompt: "queued-past-expiry",
			status: "queued",
			expires_at: new Date(Date.now() - 1_000).toISOString(),
		}));
		store.purgeExpired();
		// still present: expiring queued mail is the server sweep's job (it marks
		// the in-memory message expired first)
		expect(store.inbox("ops", 10)).toHaveLength(1);
		store.close();
	});

	test("migrates an existing messages.db without the mailbox column", () => {
		const dbPath = tmpDb();
		const raw = new Database(dbPath, { create: true });
		raw.exec(`CREATE TABLE messages (
			msg_id TEXT PRIMARY KEY, project TEXT NOT NULL, sender_session TEXT NOT NULL,
			sender_name TEXT NOT NULL DEFAULT '', sender_cwd TEXT NOT NULL DEFAULT '',
			target_session TEXT, target_name TEXT, prompt TEXT NOT NULL,
			conversation_id TEXT, response_schema TEXT, hops INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL, response TEXT, error TEXT, created_at TEXT NOT NULL,
			delivered_at TEXT, completed_at TEXT, expires_at TEXT NOT NULL
		)`);
		raw.query(
			"INSERT INTO messages (msg_id, project, sender_session, target_name, prompt, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run("OLDROW", "default", "S1", "ops", "legacy", "queued", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
		raw.close();

		const store = new MailStore(dbPath);
		const rows = store.loadNonTerminal();
		expect(rows).toHaveLength(1);
		expect(rows[0].mailbox).toBe(false); // legacy rows default to non-mailbox
		store.upsert(msg({ prompt: "new-style" }));
		// the durable inbox lists mailbox-class rows only
		expect(store.inbox("ops", 10).map((m) => m.prompt)).toEqual(["new-style"]);
		store.close();
	});
});
