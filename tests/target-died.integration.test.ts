// tests/target-died.integration.test.ts
//
// SIO-1578: when an agent unregisters with delivered-but-unreplied messages,
// the hub fails each pending msg_id with error "target_died" so senders'
// awaits resolve immediately instead of hanging until timeout.
import { afterEach, expect, test } from "bun:test";
import {
	api,
	type MessageLookup,
	readSseEvents,
	register,
	type SendResponse,
	send,
	startHub,
	stopAllHubs,
	TOKEN,
} from "./harness";

afterEach(async () => {
	await stopAllHubs();
});

async function openSse(hub: Awaited<ReturnType<typeof startHub>>, sseUrl: string): Promise<Response> {
	const resp = await fetch(hub.url + sseUrl, {
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	expect(resp.status).toBe(200);
	return resp;
}

test("shutdown of the target fails its delivered messages with target_died", async () => {
	const hub = await startHub();
	const sseA = await openSse(hub, await register(hub, "sess-a", "alice"));
	const sseB = await openSse(hub, await register(hub, "sess-b", "bob"));

	const r = await send(hub, "sess-a", "bob", "long investigation");
	expect(r.status).toBe(200);
	const { msg_id } = (await r.json()) as SendResponse;
	// Bob received the prompt (message is "delivered").
	const prompts = await readSseEvents(sseB, "prompt", 1);
	expect(prompts.length).toBe(1);

	// Bob dies before replying.
	const del = await api(hub, "DELETE", "/v1/agents/sess-b?project=default");
	expect(del.status).toBe(200);

	// Alice's stream gets a terminal response event for the pending msg_id.
	const responses = await readSseEvents(sseA, "response", 1);
	expect(responses.length).toBe(1);
	expect(responses[0].msg_id).toBe(msg_id);
	expect(responses[0].status).toBe("error");
	expect(responses[0].error).toBe("target_died");
	expect(responses[0].reason).toBe("shutdown");

	// The stored message is terminal too.
	const g = await api(hub, "GET", `/v1/messages/${msg_id}`);
	const got = (await g.json()) as MessageLookup;
	expect(got.status).toBe("error");
	expect(got.error).toBe("target_died");
}, 15_000);

test("a pending hub-side await resolves with target_died instead of hanging", async () => {
	const hub = await startHub();
	await register(hub, "sess-a", "alice");
	const sseB = await openSse(hub, await register(hub, "sess-b", "bob"));

	const r = await send(hub, "sess-a", "bob", "another question");
	const { msg_id } = (await r.json()) as SendResponse;
	await readSseEvents(sseB, "prompt", 1);

	const t0 = Date.now();
	const awaitP = api(hub, "GET", `/v1/messages/${msg_id}/await?timeout_ms=30000`);
	await Bun.sleep(100); // let the awaiter attach
	await api(hub, "DELETE", "/v1/agents/sess-b?project=default");

	const res = (await (await awaitP).json()) as MessageLookup;
	expect(res.status).toBe("error");
	expect(res.error).toBe("target_died");
	expect(Date.now() - t0).toBeLessThan(5_000);
}, 15_000);

test("stale eviction of the target fails its delivered messages", async () => {
	const hub = await startHub(undefined, {
		PI_COMS_NET_STALE_AFTER_MS: "300",
		PI_COMS_NET_OFFLINE_AFTER_MS: "600",
	});
	const sseA = await openSse(hub, await register(hub, "sess-a", "alice"));
	const sseB = await openSse(hub, await register(hub, "sess-b", "bob"));

	const r = await send(hub, "sess-a", "bob", "heavy turn");
	const { msg_id } = (await r.json()) as SendResponse;
	await readSseEvents(sseB, "prompt", 1);

	// Keep alice fresh while bob goes silent and gets evicted by the stale scan
	// (scan interval is 5s, so this needs one tick).
	const beat = setInterval(() => {
		void api(hub, "POST", "/v1/agents/sess-a/heartbeat", {
			project: "default",
			context_used_pct: 0,
			queue_depth: 0,
		});
	}, 200);
	try {
		const responses = await readSseEvents(sseA, "response", 1, 12_000);
		expect(responses.length).toBe(1);
		expect(responses[0].msg_id).toBe(msg_id);
		expect(responses[0].error).toBe("target_died");
		expect(responses[0].reason).toBe("stale");
	} finally {
		clearInterval(beat);
	}
}, 20_000);

test("queued (undelivered) mailbox mail is untouched by another agent's death", async () => {
	const hub = await startHub();
	const sseA = await openSse(hub, await register(hub, "sess-a", "alice"));
	await openSse(hub, await register(hub, "sess-b", "bob"));

	// Mailbox-class send to an offline name: queues instead of failing.
	const r = await send(hub, "sess-a", "ghost", "for later", 3_600_000);
	expect(r.status).toBe(200);
	const { msg_id, status } = (await r.json()) as SendResponse;
	expect(status).toBe("queued");

	// An unrelated agent dying must not fail queued mail, and with no delivered
	// mail pending there is no response event at all.
	await api(hub, "DELETE", "/v1/agents/sess-b?project=default");
	const spurious = await readSseEvents(sseA, "response", 1, 700);
	expect(spurious.length).toBe(0);

	const g = await api(hub, "GET", `/v1/messages/${msg_id}`);
	expect(((await g.json()) as MessageLookup).status).toBe("queued");

	// The queued message still flushes when the name finally connects.
	const sseG = await openSse(hub, await register(hub, "sess-g", "ghost"));
	const prompts = await readSseEvents(sseG, "prompt", 1);
	expect(prompts.length).toBe(1);
	expect(prompts[0].msg_id).toBe(msg_id);
}, 15_000);
