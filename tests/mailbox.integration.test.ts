// tests/mailbox.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	api,
	type MessageLookup,
	readSseEvents,
	register,
	type SendResponse,
	send,
	startHub,
	stopAllHubs,
	stopHub,
	TOKEN,
} from "./harness.ts";

afterEach(async () => {
	await stopAllHubs();
});

describe("mailbox send", () => {
	test("long-TTL send to an offline name queues instead of 404", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		const r = await send(hub, "SENDER", "laptop", "report 1", 86_400_000);
		expect(r.status).toBe(200);
		const body = (await r.json()) as SendResponse;
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

	test("ttl_ms is capped by PI_COMS_NET_MAX_TTL_MS default 14 days", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		const r = await send(hub, "SENDER", "laptop", "hi", 999_999_999_999);
		expect(r.status).toBe(200);
		// row is on disk with a capped expiry
		const db = path.join(hub.home, ".pi", "coms-net", "projects", "default", "messages.db");
		expect(fs.existsSync(db)).toBe(true);
		const { Database } = await import("bun:sqlite");
		const row = new Database(db, { readonly: true })
			.query("SELECT expires_at FROM messages")
			.get() as { expires_at: string };
		const ttl = Date.parse(row.expires_at) - Date.now();
		expect(ttl).toBeLessThanOrEqual(1_209_600_000 + 5_000);
		expect(ttl).toBeGreaterThan(1_200_000_000);
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
		const body = (await r.json()) as SendResponse;
		expect(body.status).toBe("delivered");
		expect(body.target_session).toBe("TGT");
		await resp.body?.cancel();
	});
});

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
		await resp.body?.cancel();
	});

	test("queued mail survives a hub restart", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		await send(hub, "SENDER", "laptop", "durable report", 86_400_000);
		const home = hub.home;
		await stopHub(hub);
		const hub2 = await startHub(home);
		const sseUrl = await register(hub2, "LAP2", "laptop");
		const resp = await fetch(hub2.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		const prompts = await readSseEvents(resp, "prompt", 1);
		expect(prompts).toHaveLength(1);
		expect(prompts[0].prompt).toBe("durable report");
		expect(prompts[0].sender.name).toBe("monitor");
		await resp.body?.cancel();
	});

	test("responding to flushed mail works end to end", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		const s = await send(hub, "SENDER", "laptop", "ack me", 86_400_000);
		const { msg_id } = (await s.json()) as SendResponse;
		const sseUrl = await register(hub, "LAP", "laptop");
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		const [prompt] = await readSseEvents(resp, "prompt", 1);
		const rr = await api(hub, "POST", `/v1/messages/${prompt.msg_id}/response`, {
			project: "default",
			responder_session: "LAP",
			response: "acked",
			error: null,
		});
		expect(rr.status).toBe(200);
		const g = await api(hub, "GET", `/v1/messages/${msg_id}`);
		expect(((await g.json()) as MessageLookup).response).toBe("acked");
		await resp.body?.cancel();
	});
});
