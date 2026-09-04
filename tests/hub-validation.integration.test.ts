// tests/hub-validation.integration.test.ts
//
// Single-token hub: project-name validation, no store creation for unknown
// projects, request body cap, and the shared-token regression guard for
// session ownership (every caller is the same principal).
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { api, type ErrorResponse, type InboxListing, register, startHub, stopAllHubs, TOKEN } from "./harness.ts";

afterEach(async () => {
	await stopAllHubs();
});

describe("hub request validation", () => {
	test("a project name that is not a plain directory name is 400", async () => {
		const hub = await startHub();
		const r = await api(hub, "POST", "/v1/agents/register", {
			project: "../../evil",
			session_id: "S1",
			name: "x",
			purpose: "",
			model: "t",
			color: "#888888",
			cwd: "/tmp",
			explicit: false,
		});
		expect(r.status).toBe(400);
		expect(((await r.json()) as ErrorResponse).error).toBe("invalid_project");
		expect(fs.existsSync(path.join(hub.home, ".pi", "coms-net", "evil"))).toBe(false);
		expect((await api(hub, "GET", "/v1/mailbox?project=..&name=ops")).status).toBe(400);
	});

	test("reading the inbox of an unknown project is empty and creates nothing on disk", async () => {
		const hub = await startHub();
		const r = await api(hub, "GET", "/v1/mailbox?project=nope&name=ops");
		expect(r.status).toBe(200);
		expect(((await r.json()) as InboxListing).messages).toEqual([]);
		expect(fs.existsSync(path.join(hub.home, ".pi", "coms-net", "projects", "nope"))).toBe(false);
	});

	test("a request body above the cap is 413", async () => {
		const hub = await startHub(undefined, { PI_COMS_NET_MAX_BODY_BYTES: "65536" });
		await register(hub, "S1", "a");
		const r = await api(hub, "POST", "/v1/messages", {
			project: "default",
			sender_session: "S1",
			target: "a",
			target_session: null,
			prompt: "x".repeat(70_000),
			conversation_id: null,
			response_schema: null,
			hops: 0,
		});
		expect(r.status).toBe(413);
	});

	test("with the shared token every caller owns every session", async () => {
		const hub = await startHub();
		await register(hub, "S1", "a");
		await register(hub, "S2", "b");
		const hb = { project: "default", context_used_pct: 1, queue_depth: 0 };
		expect((await api(hub, "POST", "/v1/agents/S1/heartbeat", hb, TOKEN)).status).toBe(200);
		expect((await api(hub, "DELETE", "/v1/agents/S2?project=default", undefined, TOKEN)).status).toBe(200);
	});
});
