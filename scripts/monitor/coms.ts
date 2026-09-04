// scripts/monitor/coms.ts

import * as crypto from "node:crypto";
import { errorMessage } from "./errors.ts";

// Bound on parked reply entries; the hub answers /v1/messages/:id for evicted ids.
const PENDING_CAP = 200;

export type InboundPrompt = {
	msg_id: string;
	sender_name: string;
	prompt: string;
	response_schema: object | null;
};

type Opts = {
	serverUrl: string;
	token: string;
	project: string;
	name: string;
	purpose: string;
	onPrompt: (p: InboundPrompt) => Promise<string>;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

type PendingReply = {
	promise: Promise<{ response?: unknown; error?: string | null }>;
	resolve: (v: { response?: unknown; error?: string | null }) => void;
	result?: { response?: unknown; error?: string | null };
};

// Hub reply shapes this client reads (see RegisterResponse / SendResponse in
// scripts/coms-net-server.ts).
type RegisterReply = { agent: { name: string }; sse_url: string; heartbeat_interval_ms?: number };
type SendReply = { msg_id: string; status: string };

type FramePayload = {
	msg_id: string;
	sender?: { name?: string };
	prompt?: string;
	response_schema?: object | null;
	response?: unknown;
	error?: string | null;
};

export class MonitorComs {
	private opts: Opts;
	private sessionId = ulid();
	private assignedName: string;
	private sseUrl: string | null = null;
	private sseAbort: AbortController | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;
	private pending = new Map<string, PendingReply>();

	constructor(opts: Opts) {
		this.opts = opts;
		this.assignedName = opts.name;
	}

	get name(): string {
		return this.assignedName;
	}

	private async http<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
		const resp = await fetch(this.opts.serverUrl + p, {
			method,
			headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await resp.text();
		let parsed: unknown = null;
		if (text.length > 0) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}
		if (!resp.ok) {
			const detail =
				typeof parsed === "object" && parsed !== null && "error" in parsed && parsed.error != null
					? parsed.error
					: text;
			throw Object.assign(new Error(`HTTP ${resp.status} ${method} ${p}: ${detail}`), {
				status: resp.status,
				body: parsed,
			});
		}
		return parsed as T;
	}

	private registerBody(name: string) {
		return {
			project: this.opts.project,
			session_id: this.sessionId,
			name,
			purpose: this.opts.purpose,
			model: "none",
			color: "#5599DD",
			cwd: process.cwd(),
			explicit: true,
		};
	}

	async start(): Promise<void> {
		const reg = await this.http<RegisterReply>("POST", "/v1/agents/register", this.registerBody(this.opts.name));
		this.assignedName = reg.agent.name;
		this.sseUrl = reg.sse_url;
		void this.sseLoop();
		this.heartbeatTimer = setInterval(() => {
			this.http("POST", `/v1/agents/${encodeURIComponent(this.sessionId)}/heartbeat`, {
				project: this.opts.project,
				context_used_pct: 0,
				queue_depth: 0,
				status: "online",
			}).catch(() => {
				// transient; the SSE loop re-registers on disconnect
			});
		}, reg.heartbeat_interval_ms ?? 10_000);
		this.heartbeatTimer.unref();
	}

	private async sseLoop(): Promise<void> {
		while (!this.stopped) {
			const ac = new AbortController();
			this.sseAbort = ac;
			try {
				const resp = await fetch(this.opts.serverUrl + this.sseUrl, {
					headers: { authorization: `Bearer ${this.opts.token}`, accept: "text/event-stream" },
					signal: ac.signal,
				});
				if (!resp.ok || !resp.body) throw new Error(`sse http ${resp.status}`);
				const reader = resp.body.getReader();
				const dec = new TextDecoder();
				let buf = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					for (let idx = buf.indexOf("\n\n"); idx >= 0; idx = buf.indexOf("\n\n")) {
						const frame = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						this.handleFrame(frame);
					}
				}
			} catch {
				if (this.stopped) return;
			}
			if (this.stopped) return;
			await Bun.sleep(2_000);
			// Re-register: the session may have been reaped while disconnected.
			try {
				const reg = await this.http<RegisterReply>("POST", "/v1/agents/register", this.registerBody(this.assignedName));
				this.sseUrl = reg.sse_url;
			} catch {
				// hub unreachable; retry next loop
			}
		}
	}

	private handleFrame(frame: string): void {
		let event = "message";
		let data = "";
		for (const line of frame.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data = line.slice(5).trim();
		}
		if (!data) return;
		let payload: FramePayload;
		try {
			payload = JSON.parse(data);
		} catch {
			return;
		}
		if (event === "prompt") {
			const p: InboundPrompt = {
				msg_id: payload.msg_id,
				sender_name: payload.sender?.name ?? "unknown",
				prompt: payload.prompt ?? "",
				response_schema: payload.response_schema ?? null,
			};
			void this.answer(p);
		} else if (event === "response") {
			const pend = this.pending.get(payload.msg_id);
			if (pend) {
				pend.result = { response: payload.response, error: payload.error ?? null };
				pend.resolve(pend.result);
			}
		}
	}

	private async answer(p: InboundPrompt): Promise<void> {
		let response = "";
		let error: string | null = null;
		try {
			response = await this.opts.onPrompt(p);
		} catch (e) {
			error = errorMessage(e);
		}
		try {
			await this.http("POST", `/v1/messages/${encodeURIComponent(p.msg_id)}/response`, {
				project: this.opts.project,
				responder_session: this.sessionId,
				response: error ? null : response,
				error,
			});
		} catch {
			// message may have expired
		}
	}

	// Fire-and-forget sends (reports, digests) must not park a pending entry:
	// nothing would ever consume it (SIO-1612).
	async send(
		target: string,
		prompt: string,
		opts: { ttl_ms?: number; response_schema?: object; expectReply?: boolean } = {},
	): Promise<{ msg_id: string; status: string }> {
		const resp = await this.http<SendReply>("POST", "/v1/messages", {
			project: this.opts.project,
			sender_session: this.sessionId,
			target,
			target_session: null,
			prompt,
			conversation_id: null,
			response_schema: opts.response_schema ?? null,
			hops: 0,
			...(opts.ttl_ms ? { ttl_ms: opts.ttl_ms } : {}),
		});
		if (opts.expectReply !== false) {
			let resolve!: (v: { response?: unknown; error?: string | null }) => void;
			const promise = new Promise<{ response?: unknown; error?: string | null }>((res) => {
				resolve = res;
			});
			this.pending.set(resp.msg_id, { promise, resolve });
			while (this.pending.size > PENDING_CAP) {
				const oldest = this.pending.keys().next().value;
				if (oldest === undefined) break;
				this.pending.delete(oldest);
			}
		}
		return { msg_id: resp.msg_id, status: resp.status };
	}

	pendingSize(): number {
		return this.pending.size;
	}

	async awaitReply(msg_id: string, timeoutMs: number): Promise<{ response?: unknown; error?: string | null }> {
		const pend = this.pending.get(msg_id);
		if (pend?.result) {
			this.pending.delete(msg_id);
			return pend.result;
		}
		const local = pend ? pend.promise : new Promise<never>(() => {});
		const timeout = Bun.sleep(timeoutMs).then(() => ({ error: "timeout" as const }));
		const winner = await Promise.race([local, timeout]);
		this.pending.delete(msg_id);
		return winner as { response?: unknown; error?: string | null };
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.sseAbort?.abort();
		try {
			await this.http(
				"DELETE",
				`/v1/agents/${encodeURIComponent(this.sessionId)}?project=${encodeURIComponent(this.opts.project)}`,
			);
		} catch {
			// hub may be gone
		}
	}
}
