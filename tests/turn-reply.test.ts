// tests/turn-reply.test.ts
//
// SIO-1598: when several inbound prompts stack up during one long turn,
// agent_end must reply to every unfulfilled inbound, not just the newest --
// the older senders' awaits otherwise time out forever and the stale queue
// entries swallow later turns' output.
import { expect, test } from "bun:test";
import { buildTurnReplies, outboundHops } from "../extensions/turnReply";

const text = "Investigation complete: no observed WAF changes in the last 72h.";

test("replies to every unfulfilled inbound with the turn's final text", () => {
	const replies = buildTurnReplies(
		[
			{ msg_id: "m1", fulfilled: false },
			{ msg_id: "m2", fulfilled: false },
			{ msg_id: "m3", fulfilled: false },
		],
		text,
	);
	expect(replies).toEqual([
		{ msg_id: "m1", response: text, error: null },
		{ msg_id: "m2", response: text, error: null },
		{ msg_id: "m3", response: text, error: null },
	]);
});

test("replies oldest-first (input order preserved)", () => {
	const replies = buildTurnReplies(
		[
			{ msg_id: "older", fulfilled: false },
			{ msg_id: "newer", fulfilled: false },
		],
		text,
	);
	expect(replies.map((r) => r.msg_id)).toEqual(["older", "newer"]);
});

test("skips already-fulfilled inbounds", () => {
	const replies = buildTurnReplies(
		[
			{ msg_id: "done", fulfilled: true },
			{ msg_id: "pending", fulfilled: false },
		],
		text,
	);
	expect(replies.map((r) => r.msg_id)).toEqual(["pending"]);
});

test("empty queue yields no replies", () => {
	expect(buildTurnReplies([], text)).toEqual([]);
});

// SIO-1611: outbound hops derive from every unfulfilled inbound of the turn,
// not from whichever prompt arrived last.
test("outboundHops is 0 for a user-started turn", () => {
	expect(outboundHops([])).toBe(0);
});

test("outboundHops is one past the deepest unfulfilled inbound", () => {
	expect(outboundHops([
		{ hops: 4, fulfilled: false },
		{ hops: 0, fulfilled: false },
	])).toBe(5);
});

test("outboundHops ignores fulfilled inbounds", () => {
	expect(outboundHops([
		{ hops: 4, fulfilled: true },
		{ hops: 1, fulfilled: false },
	])).toBe(2);
	expect(outboundHops([{ hops: 4, fulfilled: true }])).toBe(0);
});

test("schema inbound gets JSON extracted from fenced output", () => {
	const obj = { verdict: "clean" };
	const replies = buildTurnReplies(
		[{ msg_id: "m1", fulfilled: false, response_schema: { type: "object" } }],
		"Here you go:\n```json\n" + JSON.stringify(obj) + "\n```",
	);
	expect(replies).toEqual([{ msg_id: "m1", response: obj, error: null }]);
});

test("schema inbound with non-JSON text reports the extraction error", () => {
	const replies = buildTurnReplies(
		[{ msg_id: "m1", fulfilled: false, response_schema: { type: "object" } }],
		"sorry, plain prose only",
	);
	expect(replies).toEqual([
		{ msg_id: "m1", response: null, error: "response not valid JSON" },
	]);
});

test("mixed schema and plain inbounds each get their own treatment", () => {
	const obj = { ok: true };
	const raw = JSON.stringify(obj);
	const replies = buildTurnReplies(
		[
			{ msg_id: "plain", fulfilled: false },
			{ msg_id: "schema", fulfilled: false, response_schema: { type: "object" } },
		],
		raw,
	);
	expect(replies).toEqual([
		{ msg_id: "plain", response: raw, error: null },
		{ msg_id: "schema", response: obj, error: null },
	]);
});

// SIO-1625: the agent_end text extraction and the claim-before-post step
// moved out of the extension so they can be tested here.
import { claimTurnReplies, lastAssistantText } from "../extensions/turnReply";

test("lastAssistantText takes the latest assistant message and joins its text blocks", () => {
	const messages = [
		{ role: "user", content: "question" },
		{ role: "assistant", content: "first answer" },
		{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "final" },
				{ type: "toolCall", name: "bash" },
				{ type: "text", text: "answer" },
			],
		},
	];
	expect(lastAssistantText(messages)).toBe("final\nanswer");
});

test("lastAssistantText accepts string content and returns empty when no assistant spoke", () => {
	expect(lastAssistantText([{ role: "assistant", content: "plain" }])).toBe("plain");
	expect(lastAssistantText([{ role: "user", content: "only me" }])).toBe("");
	expect(lastAssistantText([{ role: "assistant", content: [{ type: "text", text: 42 }] }])).toBe("");
});

test("claimTurnReplies replies once per unfulfilled inbound and empties the queue", () => {
	const queue = new Map([
		["M1", { msg_id: "M1", fulfilled: false, hops: 0 }],
		["M2", { msg_id: "M2", fulfilled: true, hops: 0 }],
		["M3", { msg_id: "M3", fulfilled: false, hops: 1, response_schema: { type: "object" } }],
	]);
	const replies = claimTurnReplies(queue, '{"ok":true}');
	expect(replies.map((r) => r.msg_id)).toEqual(["M1", "M3"]);
	expect(replies[1]?.response).toEqual({ ok: true });
	expect(queue.has("M1")).toBe(false);
	expect(queue.has("M3")).toBe(false);
	// The already-fulfilled entry is left alone for its owner to drop.
	expect(queue.get("M2")?.fulfilled).toBe(true);
	// A second agent_end for the same turn has nothing left to submit.
	expect(claimTurnReplies(queue, "later text")).toEqual([]);
});
