// tests/sse-reconnect.integration.test.ts
//
// A client that reopens its SSE stream (reconnect) replaces the old stream on
// the hub. Peers must not see an agent_left for a session that is still
// registered and streaming; a real disconnect still announces exactly one.
import { afterEach, expect, test } from "bun:test";
import { activeHubs, readSseEvents, register, startHub, stopHub, TOKEN } from "./harness";

afterEach(async () => {
	for (const h of [...activeHubs]) await stopHub(h);
});

const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

test("reopening a session's SSE stream does not announce agent_left; closing it does, once", async () => {
	const hub = await startHub();
	const observerUrl = await register(hub, "OBS", "observer");
	const agentUrl = await register(hub, "AG", "agent");

	const observer = await fetch(hub.url + observerUrl, auth);
	await readSseEvents(observer, "hello", 1);

	const first = await fetch(hub.url + agentUrl, auth);
	await readSseEvents(first, "hello", 1);
	const second = await fetch(hub.url + agentUrl, auth);
	await readSseEvents(second, "hello", 1);
	// the hub closes the first stream itself; the client side may also drop it
	await first.body?.cancel().catch(() => {});

	const spurious = await readSseEvents(observer, "agent_left", 1, 700);
	expect(spurious).toEqual([]);

	await second.body?.cancel();
	const left = await readSseEvents(observer, "agent_left", 2, 1500);
	expect(left.map((e) => e.session_id)).toEqual(["AG"]);
	await observer.body?.cancel();
});
