// tests/turn-reply.test.ts
//
// SIO-1598: when several inbound prompts stack up during one long turn,
// agent_end must reply to every unfulfilled inbound, not just the newest --
// the older senders' awaits otherwise time out forever and the stale queue
// entries swallow later turns' output.
import { expect, test } from "bun:test";
import { buildTurnReplies } from "../extensions/turnReply";

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
