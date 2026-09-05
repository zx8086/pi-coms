// tests/monitor-coms.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { MonitorComs } from "../scripts/monitor/coms.ts";
import { startHub, stopAllHubs, TOKEN } from "./harness.ts";

afterEach(async () => {
	await stopAllHubs();
});

async function sendWithRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			await new Promise((r) => setTimeout(r, 25 * attempt));
		}
	}
	throw lastError;
}

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

	test("pending entries are bounded: fire-and-forget sends park nothing, awaited replies clear, cap holds", async () => {
		const hub = await startHub();
		const agent = new MonitorComs({
			serverUrl: hub.url,
			token: TOKEN,
			project: "default",
			name: "monitor-aws-123",
			purpose: "t",
			onPrompt: async (p) => `pong:${p.prompt}`,
		});
		await agent.start();
		const peer = new MonitorComs({
			serverUrl: hub.url,
			token: TOKEN,
			project: "default",
			name: "ops",
			purpose: "t",
			onPrompt: async () => "ok",
		});
		await peer.start();

		await agent.send("ops", "digest", { ttl_ms: 86_400_000, expectReply: false });
		expect(agent.pendingSize()).toBe(0);

		const sent = await peer.send("monitor-aws-123", "status");
		expect(peer.pendingSize()).toBe(1);
		await peer.awaitReply(sent.msg_id, 10_000);
		expect(peer.pendingSize()).toBe(0);

		// 210 rapid sends over keep-alive connections. Bun's fetch reports a closed
		// socket under CI load, and a single retry was not enough on the shared
		// runner (SIO-1633). A duplicate send after a lost response cannot change
		// the result: the assertion is the pending cap, not the send count.
		for (let i = 0; i < 210; i++) {
			await sendWithRetry(() => agent.send("ops", `r${i}`, { ttl_ms: 86_400_000 }));
		}
		expect(agent.pendingSize()).toBe(200);

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
