// tests/inbox-format.test.ts
import { describe, expect, test } from "bun:test";
import { formatInbox, INBOX_PREVIEW_CHARS, type InboxMessage } from "../extensions/inboxFormat.ts";

let seq = 0;
const msg = (over: Partial<InboxMessage> = {}): InboxMessage => {
	seq += 1;
	return {
		msg_id: `01TEST${String(seq).padStart(20, "0")}`,
		sender_name: "monitor-eu-oit-dev",
		status: "delivered",
		created_at: "2026-09-02T00:01:27.328Z",
		prompt: "report body",
		...over,
	};
};

describe("formatInbox", () => {
	test("empty inbox renders the empty line", () => {
		expect(formatInbox("ops", [])).toBe('Inbox "ops" is empty.');
	});

	test("listing keeps bodies up to the preview cap intact, no ellipsis", () => {
		const body = "x".repeat(INBOX_PREVIEW_CHARS);
		const text = formatInbox("ops", [msg({ prompt: body })]);
		expect(text).toContain(body);
		expect(text).not.toContain("…");
	});

	test("listing truncates a long body at the preview cap with an ellipsis", () => {
		const body = "a".repeat(INBOX_PREVIEW_CHARS) + "CERT_DETAIL_BEYOND_CAP";
		const text = formatInbox("ops", [msg({ prompt: body })]);
		expect(text).not.toContain("CERT_DETAIL_BEYOND_CAP");
		expect(text).toContain("…");
	});

	test("preview cap is 2000, not the old 400", () => {
		const body = "b".repeat(500);
		const text = formatInbox("ops", [msg({ prompt: body })]);
		expect(text).toContain(body);
	});

	test("listing indents body newlines and carries header, sender, status, msg_id", () => {
		const m = msg({ prompt: "line1\nline2" });
		const text = formatInbox("ops", [m, msg()]);
		expect(text).toContain('Inbox "ops": 2 message(s)');
		expect(text).toContain("line1\n  line2");
		expect(text).toContain(`from ${m.sender_name} (${m.status}) msg_id ${m.msg_id}`);
	});

	test("msg_id returns that message with the full untruncated body", () => {
		const body = "c".repeat(INBOX_PREVIEW_CHARS * 2) + "TAIL_MARKER";
		const target = msg({ prompt: body });
		const text = formatInbox("ops", [msg(), target, msg()], { msgId: target.msg_id });
		expect(text).toContain("TAIL_MARKER");
		expect(text).not.toContain("…");
		expect(text).toContain(target.msg_id);
		expect(text).toContain("full");
	});

	test("msg_id miss names the id and how to widen the fetch", () => {
		const text = formatInbox("ops", [msg(), msg()], { msgId: "01NOPE" });
		expect(text).toContain("01NOPE");
		expect(text).toContain("not found");
		expect(text).toMatch(/limit|since/);
	});
});

test("a completed conversation shows its reply under the prompt; a failed one shows the error", () => {
	const out = formatInbox("eu-oit-dev", [
		{ msg_id: "m1", sender_name: "simon", status: "complete", created_at: "t1", prompt: "how many RDS?", response: "three" },
		{ msg_id: "m2", sender_name: "simon", status: "error", created_at: "t2", prompt: "and now?", response: null, error: "expired" },
	]);
	expect(out).toContain("how many RDS?\n  reply: three");
	expect(out).toContain("and now?\n  reply: (expired)");
});
