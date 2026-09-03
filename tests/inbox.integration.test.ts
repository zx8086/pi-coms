// tests/inbox.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { api, readSseEvents, register, send, startHub, stopAllHubs, stopHub, TOKEN } from "./harness.ts";

afterEach(async () => {
	await stopAllHubs();
});

describe("shared inbox", () => {
	test("two sessions read the same inbox, including completed reports", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		await send(hub, "SENDER", "ops", "report one", 86_400_000);
		await Bun.sleep(10);
		const s2 = await send(hub, "SENDER", "ops", "report two", 86_400_000);
		const { msg_id: secondId } = (await s2.json()) as any;

		// Deliver and complete the first report through a duty session.
		const sseUrl = await register(hub, "DUTY", "ops");
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		const prompts = await readSseEvents(resp, "prompt", 2);
		await api(hub, "POST", `/v1/messages/${prompts[0].msg_id}/response`, {
			project: "default", responder_session: "DUTY", response: "ack", error: null,
		});
		await resp.body?.cancel();

		// Two other operators read the same inbox on demand.
		await register(hub, "USER1", "simon");
		await register(hub, "USER2", "jane");
		const read = async () => {
			const r = await api(hub, "GET", "/v1/mailbox?project=default&name=ops&limit=10");
			expect(r.status).toBe(200);
			return ((await r.json()) as any).messages;
		};
		const one = await read();
		const two = await read();
		expect(one).toEqual(two);
		expect(one).toHaveLength(2);
		expect(one.map((m: any) => m.prompt)).toEqual(["report one", "report two"]);
		expect(one[0].status).toBe("complete"); // completed mail stays readable
		expect(one[0].sender_name).toBe("monitor");

		// since-cursor: only the second report comes back.
		const r = await api(hub, "GET", `/v1/mailbox?project=default&name=ops&limit=10&since=${one[0].msg_id}`);
		const newer = ((await r.json()) as any).messages;
		expect(newer.map((m: any) => m.msg_id)).toEqual([secondId]);
	});

	test("inbox survives a hub restart", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		await send(hub, "SENDER", "ops", "durable report", 86_400_000);
		const home = hub.home;
		await stopHub(hub);
		const hub2 = await startHub(home);
		await register(hub2, "USER1", "simon");
		const r = await api(hub2, "GET", "/v1/mailbox?project=default&name=ops&limit=10");
		const msgs = ((await r.json()) as any).messages;
		expect(msgs.map((m: any) => m.prompt)).toEqual(["durable report"]);
	});

	test("short-TTL messages are not part of the durable inbox", async () => {
		const hub = await startHub();
		await register(hub, "SENDER", "monitor");
		const sseUrl = await register(hub, "TGT", "helper");
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
		await Bun.sleep(100);
		await send(hub, "SENDER", "helper", "quick question"); // default TTL
		const [prompt] = await readSseEvents(resp, "prompt", 1);
		await api(hub, "POST", `/v1/messages/${prompt.msg_id}/response`, {
			project: "default", responder_session: "TGT", response: "answer", error: null,
		});
		await resp.body?.cancel();
		const r = await api(hub, "GET", "/v1/mailbox?project=default&name=helper&limit=10");
		expect(((await r.json()) as any).messages).toHaveLength(0);
	});

	test("mailbox endpoint requires auth and a name", async () => {
		const hub = await startHub();
		const noAuth = await fetch(hub.url + "/v1/mailbox?name=ops");
		expect(noAuth.status).toBe(401);
		const noName = await api(hub, "GET", "/v1/mailbox?project=default");
		expect(noName.status).toBe(400);
	});
});
