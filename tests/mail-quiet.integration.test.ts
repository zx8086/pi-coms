// tests/mail-quiet.integration.test.ts
//
// SIO-1579: prompt events carry the message's mailbox class so recipients can
// keep mail out of the model -- mailbox mail is read on demand via the inbox,
// only interactive (short-TTL) sends may trigger turns.
import { afterEach, expect, test } from "bun:test";
import { activeHubs, api, readSseEvents, register, send, startHub, stopHub, TOKEN } from "./harness";

afterEach(async () => {
	for (const h of [...activeHubs]) await stopHub(h);
});

async function openSse(hub: Awaited<ReturnType<typeof startHub>>, sseUrl: string): Promise<Response> {
	const resp = await fetch(hub.url + sseUrl, {
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	expect(resp.status).toBe(200);
	return resp;
}

test("online delivery marks mailbox sends and leaves interactive sends unmarked", async () => {
	const hub = await startHub();
	await register(hub, "sess-a", "alice");
	const sseB = await openSse(hub, await register(hub, "sess-b", "bob"));

	await send(hub, "sess-a", "bob", "monitor report", 3_600_000);
	await send(hub, "sess-a", "bob", "interactive question");

	const prompts = await readSseEvents(sseB, "prompt", 2);
	expect(prompts.length).toBe(2);
	const mail = prompts.find((p) => p.prompt === "monitor report");
	const chat = prompts.find((p) => p.prompt === "interactive question");
	expect(mail.mailbox).toBe(true);
	expect(chat.mailbox ?? false).toBe(false);
}, 15_000);

test("queued mail flushed on connect is marked mailbox and stays inbox-readable", async () => {
	const hub = await startHub();
	await register(hub, "sess-a", "alice");

	const r = await send(hub, "sess-a", "ghost", "for later", 3_600_000);
	expect(((await r.json()) as any).status).toBe("queued");

	const sseG = await openSse(hub, await register(hub, "sess-g", "ghost"));
	const prompts = await readSseEvents(sseG, "prompt", 1);
	expect(prompts.length).toBe(1);
	expect(prompts[0].mailbox).toBe(true);

	// Delivered-but-unanswered mail remains readable on demand.
	const inbox = await api(hub, "GET", "/v1/mailbox?name=ghost");
	expect(inbox.status).toBe(200);
	const rows = ((await inbox.json()) as any).messages;
	expect(rows.length).toBe(1);
	expect(rows[0].prompt).toBe("for later");
}, 15_000);
