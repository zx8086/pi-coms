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
		mailbox: true,
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
