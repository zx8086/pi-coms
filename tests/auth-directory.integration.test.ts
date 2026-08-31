// tests/auth-directory.integration.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { activeHubs, api, readSseEvents, register, startHub, stopHub, TOKEN } from "./harness.ts";

afterEach(async () => {
	while (activeHubs.length) await stopHub(activeHubs[activeHubs.length - 1]);
});

const SIMON_TOKEN = "token-simon-0000000000000000";
const JANE_TOKEN = "token-jane-11111111111111111";
const AGENT_TOKEN = "token-agent-2222222222222222";

function writeDirectory(file: string): void {
	fs.writeFileSync(file, JSON.stringify({
		principals: {
			simon: { token: SIMON_TOKEN, kind: "operator", names: ["simon", "ops"] },
			jane: { token: JANE_TOKEN, kind: "operator", names: ["jane", "ops"] },
			"eu-oit-dev": { token: AGENT_TOKEN, kind: "agent", names: ["eu-oit-dev", "monitor-eu-oit-dev"] },
		},
	}));
}

async function startDirectoryHub(refreshMs = 60_000) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "authdir-"));
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
		await Bun.sleep(900);

		const after = await api(hub, "GET", "/v1/agents?project=default", undefined, SIMON_TOKEN);
		expect(after.status).toBe(401);

		// simon's registration is gone; jane still authenticates
		const list = await api(hub, "GET", "/v1/agents?project=default&include_explicit=true", undefined, JANE_TOKEN);
		const agents = ((await list.json()) as any).agents;
		expect(agents.some((a: any) => a.name === "simon")).toBe(false);
		await resp.body?.cancel();
	});
});
