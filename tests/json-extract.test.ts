// tests/json-extract.test.ts
//
// SIO-1580: schema-constrained replies must survive markdown fences and prose
// wrapping -- eu Sonnet 5 rarely emits bare JSON.
import { expect, test } from "bun:test";
import { extractJsonPayload } from "../extensions/jsonPayload";

const obj = { diagnoses: [{ dedup_key: "k", probable_cause: "c" }] };
const json = JSON.stringify(obj);

test("bare JSON object", () => {
	expect(extractJsonPayload(json)).toEqual(obj);
});

test("bare JSON array", () => {
	expect(extractJsonPayload("[1, 2, 3]")).toEqual([1, 2, 3]);
});

test("fenced with language tag", () => {
	expect(extractJsonPayload("```json\n" + json + "\n```")).toEqual(obj);
});

test("fenced without language tag", () => {
	expect(extractJsonPayload("```\n" + json + "\n```")).toEqual(obj);
});

test("prose before and after the object", () => {
	expect(
		extractJsonPayload("Here is my diagnosis:\n\n" + json + "\n\nLet me know if you need more."),
	).toEqual(obj);
});

test("braces inside JSON strings do not break extraction", () => {
	const tricky = { note: 'contains } and { and "quoted \\" brace }"' };
	expect(extractJsonPayload("reply: " + JSON.stringify(tricky) + " done")).toEqual(tricky);
});

test("no JSON at all returns undefined", () => {
	expect(extractJsonPayload("I could not complete the investigation.")).toBeUndefined();
});

test("unbalanced braces return undefined", () => {
	expect(extractJsonPayload('{"a": 1')).toBeUndefined();
});
