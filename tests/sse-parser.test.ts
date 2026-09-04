// tests/sse-parser.test.ts
import { expect, test } from "bun:test";
import { makeSseParser } from "../extensions/sseParser.ts";

type Seen = { event: string; data: unknown; id?: string };

function collect(): { seen: Seen[]; parser: ReturnType<typeof makeSseParser> } {
	const seen: Seen[] = [];
	const parser = makeSseParser((event, data, id) => seen.push({ event, data, id }));
	return { seen, parser };
}

test("parses event, data and id lines into one event with JSON data", () => {
	const { seen, parser } = collect();
	parser.feed('event: prompt\nid: 7\ndata: {"msg_id":"M1","prompt":"hi"}\n\n');
	expect(seen).toEqual([{ event: "prompt", data: { msg_id: "M1", prompt: "hi" }, id: "7" }]);
});

test("defaults the event name to message and keeps non-JSON data as a string", () => {
	const { seen, parser } = collect();
	parser.feed("data: plain text\n\n");
	expect(seen).toEqual([{ event: "message", data: "plain text", id: undefined }]);
});

test("joins multi-line data with newlines before parsing", () => {
	const { seen, parser } = collect();
	parser.feed('data: {"a":\ndata: 1}\n\n');
	expect(seen[0]?.data).toEqual({ a: 1 });
});

test("skips comment lines and frames without data (server pings)", () => {
	const { seen, parser } = collect();
	parser.feed(": keep-alive\n\nevent: server_ping\n\ndata: 1\n\n");
	expect(seen).toEqual([{ event: "message", data: 1, id: undefined }]);
});

test("reassembles a frame split across chunks, including inside a UTF-8 sequence", () => {
	const { seen, parser } = collect();
	const bytes = new TextEncoder().encode('data: {"name":"Zoë"}\n\n');
	const cut = bytes.indexOf(0xc3) + 1; // split between the two bytes of "ë"
	parser.feed(bytes.slice(0, cut));
	expect(seen).toHaveLength(0);
	parser.feed(bytes.slice(cut));
	expect(seen).toEqual([{ event: "message", data: { name: "Zoë" }, id: undefined }]);
});

test("delivers several frames from one chunk in order", () => {
	const { seen, parser } = collect();
	parser.feed("event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n");
	expect(seen.map((s) => s.event)).toEqual(["a", "b", "c"]);
});

test("a throwing handler does not stop later frames", () => {
	const seen: string[] = [];
	const parser = makeSseParser((event) => {
		if (event === "boom") throw new Error("handler failed");
		seen.push(event);
	});
	parser.feed("event: boom\ndata: 1\n\nevent: fine\ndata: 2\n\n");
	expect(seen).toEqual(["fine"]);
});

test("a trailing partial frame stays buffered until its blank line arrives", () => {
	const { seen, parser } = collect();
	parser.feed("data: 1\n\ndata: 2\n");
	expect(seen).toHaveLength(1);
	parser.feed("\n");
	expect(seen).toHaveLength(2);
});
