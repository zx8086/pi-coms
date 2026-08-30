// tests/harness.ts
//
// Shared integration-test harness: spawns the real hub server with HOME
// pointed at a temp dir so registry and mailbox state stay isolated.
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TOKEN = "test-token-mailbox";
const SERVER = path.join(import.meta.dir, "..", "scripts", "coms-net-server.ts");

export type Hub = { proc: Bun.Subprocess; url: string; home: string };
export const activeHubs: Hub[] = [];

export async function startHub(home?: string): Promise<Hub> {
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
	activeHubs.push(hub);
	return hub;
}

export async function stopHub(hub: Hub): Promise<void> {
	hub.proc.kill("SIGTERM");
	await hub.proc.exited;
	const i = activeHubs.indexOf(hub);
	if (i >= 0) activeHubs.splice(i, 1);
}

export async function api(hub: Hub, method: string, p: string, body?: unknown): Promise<Response> {
	return fetch(hub.url + p, {
		method,
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

export async function register(hub: Hub, session_id: string, name: string): Promise<string> {
	const r = await api(hub, "POST", "/v1/agents/register", {
		project: "default",
		session_id,
		name,
		purpose: "",
		model: "test",
		color: "#888888",
		cwd: "/tmp",
		explicit: false,
	});
	expect(r.status).toBe(200);
	return ((await r.json()) as any).sse_url as string;
}

export function send(hub: Hub, sender: string, target: string, prompt: string, ttl_ms?: number) {
	return api(hub, "POST", "/v1/messages", {
		project: "default",
		sender_session: sender,
		target,
		target_session: null,
		prompt,
		conversation_id: null,
		response_schema: null,
		hops: 0,
		...(ttl_ms !== undefined ? { ttl_ms } : {}),
	});
}

export async function readSseEvents(
	resp: Response,
	wanted: string,
	count: number,
	timeoutMs = 5_000,
): Promise<any[]> {
	const reader = resp.body!.getReader();
	const dec = new TextDecoder();
	let buf = "";
	const out: any[] = [];
	const deadline = Date.now() + timeoutMs;
	while (out.length < count && Date.now() < deadline) {
		const { done, value } = await Promise.race([
			reader.read(),
			Bun.sleep(Math.max(1, deadline - Date.now())).then(
				() => ({ done: true, value: undefined }) as { done: boolean; value: undefined },
			),
		]);
		if (done && !value) break;
		if (value) buf += dec.decode(value, { stream: true });
		let idx: number;
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
	try {
		reader.releaseLock();
	} catch {
		// stream may already be closed
	}
	return out;
}
