// tests/monitor-coms.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { MonitorComs } from "../scripts/monitor/coms.ts";
import { startHub, stopAllHubs, TOKEN } from "./harness.ts";

afterEach(async () => {
	await stopAllHubs();
});

describe("MonitorComs", () => {
	test("registers, sends with ttl, and answers inbound prompts", async () => {
		const hub = await startHub();
		const agent = new MonitorComs({
			serverUrl: hub.url,
			token: TOKEN,
			project: "default",
			name: "monitor-aws-123",
			purpose: "test monitor",
			onPrompt: async (p) => `pong:${p.prompt}`,
		});
		await agent.start();

		const peer = new MonitorComs({
			serverUrl: hub.url,
			token: TOKEN,
			project: "default",
			name: "laptop",
			purpose: "test operator",
			onPrompt: async () => "ok",
		});
		await peer.start();

		// send + await round trip (agent answers via onPrompt)
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
			serverUrl: hub.url,
			token: TOKEN,
			project: "default",
			name: "monitor-aws-123",
			purpose: "t",
			onPrompt: async () => "",
		});
		await agent.start();
		const sent = await agent.send("nobody-home", "report", { ttl_ms: 86_400_000 });
		expect(sent.status).toBe("queued");
		await agent.stop();
	});
});
