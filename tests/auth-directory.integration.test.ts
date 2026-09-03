// tests/auth-directory.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { api, readSseEvents, register, startHub, stopAllHubs, TOKEN } from "./harness.ts";

const tmpDirs: string[] = [];
afterEach(async () => {
	await stopAllHubs();
	while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const SIMON_TOKEN = "token-simon-0000000000000000";
const JANE_TOKEN = "token-jane-11111111111111111";
const AGENT_TOKEN = "token-agent-2222222222222222";
const KIM_TOKEN = "token-kim-333333333333333333";

function writeDirectory(file: string): void {
	fs.writeFileSync(file, JSON.stringify({
		principals: {
			simon: { token: SIMON_TOKEN, kind: "operator", names: ["simon", "ops"] },
			jane: { token: JANE_TOKEN, kind: "operator", names: ["jane", "ops"] },
			"eu-oit-dev": { token: AGENT_TOKEN, kind: "agent", names: ["eu-oit-dev", "monitor-eu-oit-dev"] },
			kim: { token: KIM_TOKEN, kind: "operator", names: ["kim"] },
		},
	}));
}

async function startDirectoryHub(refreshMs = 60_000) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "authdir-"));
	tmpDirs.push(dir);
	const file = path.join(dir, "tokens.json");
	writeDirectory(file);
	const hub = await startHub(undefined, {
		PI_COMS_NET_AUTH_FILE: file,
		PI_COMS_NET_AUTH_REFRESH_MS: String(refreshMs),
	});
	return { hub, file };
}

describe("directory auth", () => {
	test("principal registers under an allowed name; disallowed is 403; unknown token is 401", async () => {
		const { hub } = await startDirectoryHub();
		await register(hub, "S1", "simon", SIMON_TOKEN);

		const bad = await api(hub, "POST", "/v1/agents/register", {
			project: "default", session_id: "S2", name: "eu-oit-dev", purpose: "",
			model: "t", color: "#888888", cwd: "/tmp", explicit: false,
		}, SIMON_TOKEN);
		expect(bad.status).toBe(403);

		const unknown = await api(hub, "GET", "/v1/agents?project=default", undefined, "not-a-real-token");
		expect(unknown.status).toBe(401);
	});

	test("a name held by another principal is 409, not auto-suffixed", async () => {
		const { hub } = await startDirectoryHub();
		await register(hub, "S1", "ops", SIMON_TOKEN);
		const clash = await api(hub, "POST", "/v1/agents/register", {
			project: "default", session_id: "J1", name: "ops", purpose: "",
			model: "t", color: "#888888", cwd: "/tmp", explicit: false,
		}, JANE_TOKEN);
		expect(clash.status).toBe(409);
		// jane can still register under her own name
		await register(hub, "J1", "jane", JANE_TOKEN);
	});

	test("env token acts as root with unrestricted names", async () => {
		const { hub } = await startDirectoryHub();
		await register(hub, "R1", "anything-goes", TOKEN);
	});

	test("agents authenticate per-principal and messaging works across principals", async () => {
		const { hub } = await startDirectoryHub();
		await register(hub, "OP", "simon", SIMON_TOKEN);
		const sseUrl = await register(hub, "AG", "eu-oit-dev", AGENT_TOKEN);
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${AGENT_TOKEN}` } });
		await Bun.sleep(100);
		const s = await api(hub, "POST", "/v1/messages", {
			project: "default", sender_session: "OP", target: "eu-oit-dev",
			target_session: null, prompt: "hello", conversation_id: null,
			response_schema: null, hops: 0,
		}, SIMON_TOKEN);
		expect(s.status).toBe(200);
		const [prompt] = await readSseEvents(resp, "prompt", 1);
		expect(prompt.prompt).toBe("hello");
		await resp.body?.cancel();
	});

	test("revocation: removed principal is 401 on next refresh and its SSE session closes", async () => {
		const { hub, file } = await startDirectoryHub(300);
		const sseUrl = await register(hub, "S1", "simon", SIMON_TOKEN);
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${SIMON_TOKEN}` } });
		await readSseEvents(resp, "hello", 1);

		// drop simon from the directory
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		delete parsed.principals.simon;
		fs.writeFileSync(file, JSON.stringify(parsed));

		// The hub re-reads the directory every 300 ms; poll instead of sleeping a fixed time.
		let after = await api(hub, "GET", "/v1/agents?project=default", undefined, SIMON_TOKEN);
		for (let i = 0; i < 30 && after.status !== 401; i++) {
			await Bun.sleep(100);
			after = await api(hub, "GET", "/v1/agents?project=default", undefined, SIMON_TOKEN);
		}
		expect(after.status).toBe(401);

		// simon's registration is gone; jane still authenticates
		const list = await api(hub, "GET", "/v1/agents?project=default&include_explicit=true", undefined, JANE_TOKEN);
		const agents = ((await list.json()) as any).agents;
		expect(agents.some((a: any) => a.name === "simon")).toBe(false);
		await resp.body?.cancel();
	});

	test("session ownership: another principal cannot heartbeat, delete, or open SSE for a session; root can", async () => {
		const { hub } = await startDirectoryHub();
		const sseUrl = await register(hub, "S1", "simon", SIMON_TOKEN);
		await register(hub, "J1", "jane", JANE_TOKEN);

		const hb = { project: "default", context_used_pct: 1, queue_depth: 0 };
		expect((await api(hub, "POST", "/v1/agents/S1/heartbeat", hb, JANE_TOKEN)).status).toBe(403);
		expect((await api(hub, "DELETE", "/v1/agents/S1?project=default", undefined, JANE_TOKEN)).status).toBe(403);
		const foreignSse = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${JANE_TOKEN}` } });
		expect(foreignSse.status).toBe(403);

		expect((await api(hub, "POST", "/v1/agents/S1/heartbeat", hb, SIMON_TOKEN)).status).toBe(200);
		expect((await api(hub, "POST", "/v1/agents/S1/heartbeat", hb, TOKEN)).status).toBe(200);
		const ownSse = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${SIMON_TOKEN}` } });
		expect(ownSse.status).toBe(200);
		await ownSse.body?.cancel();
		expect((await api(hub, "DELETE", "/v1/agents/S1?project=default", undefined, TOKEN)).status).toBe(200);
	});

	test("a spoofed sender_session is 403", async () => {
		const { hub } = await startDirectoryHub();
		await register(hub, "S1", "simon", SIMON_TOKEN);
		await register(hub, "J1", "jane", JANE_TOKEN);
		const body = (sender: string) => ({
			project: "default", sender_session: sender, target: "simon", target_session: null,
			prompt: "hi", conversation_id: null, response_schema: null, hops: 0, ttl_ms: 60_000,
		});
		expect((await api(hub, "POST", "/v1/messages", body("S1"), JANE_TOKEN)).status).toBe(403);
		expect((await api(hub, "POST", "/v1/messages", body("J1"), JANE_TOKEN)).status).toBe(200);
	});

	test("only the principal holding the target session may answer a message", async () => {
		const { hub } = await startDirectoryHub();
		await register(hub, "OP", "simon", SIMON_TOKEN);
		const sseUrl = await register(hub, "AG", "eu-oit-dev", AGENT_TOKEN);
		const resp = await fetch(hub.url + sseUrl, { headers: { authorization: `Bearer ${AGENT_TOKEN}` } });
		await readSseEvents(resp, "hello", 1);
		const s = await api(hub, "POST", "/v1/messages", {
			project: "default", sender_session: "OP", target: "eu-oit-dev", target_session: null,
			prompt: "question", conversation_id: null, response_schema: null, hops: 0,
		}, SIMON_TOKEN);
		expect(s.status).toBe(200);
		const msg_id = ((await s.json()) as any).msg_id as string;
		await readSseEvents(resp, "prompt", 1);

		const answer = { responder_session: "AG", response: "forged", error: null };
		expect((await api(hub, "POST", `/v1/messages/${msg_id}/response`, answer, JANE_TOKEN)).status).toBe(403);
		expect((await api(hub, "POST", `/v1/messages/${msg_id}/response`, answer, AGENT_TOKEN)).status).toBe(200);
		await resp.body?.cancel();
	});

	test("shared inbox: a principal without the ops name still reads the ops history", async () => {
		const { hub } = await startDirectoryHub();
		await register(hub, "AG", "eu-oit-dev", AGENT_TOKEN);
		const s = await api(hub, "POST", "/v1/messages", {
			project: "default", sender_session: "AG", target: "ops", target_session: null,
			prompt: "nightly digest", conversation_id: null, response_schema: null, hops: 0,
			ttl_ms: 3_600_000,
		}, AGENT_TOKEN);
		expect(s.status).toBe(200);

		const kim = await api(hub, "GET", "/v1/mailbox?project=default&name=ops", undefined, KIM_TOKEN);
		expect(kim.status).toBe(200);
		const kimMsgs = ((await kim.json()) as any).messages;
		expect(kimMsgs.map((m: any) => m.prompt)).toEqual(["nightly digest"]);

		const simon = await api(hub, "GET", "/v1/mailbox?project=default&name=ops", undefined, SIMON_TOKEN);
		expect(((await simon.json()) as any).messages.map((m: any) => m.msg_id)).toEqual(kimMsgs.map((m: any) => m.msg_id));
	});
});
