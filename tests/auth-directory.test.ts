// tests/auth-directory.test.ts
import { describe, expect, test } from "bun:test";
import { nameAllowed } from "../scripts/coms-net-server.ts";

describe("nameAllowed", () => {
	const p = (names: string[]) => ({ principal: "x", kind: "operator", names });

	test("exact match", () => {
		expect(nameAllowed(p(["simon"]), "simon")).toBe(true);
		expect(nameAllowed(p(["simon"]), "simon2")).toBe(false);
		expect(nameAllowed(p(["simon", "ops"]), "ops")).toBe(true);
	});

	test("prefix wildcard", () => {
		expect(nameAllowed(p(["simon-*"]), "simon-dev")).toBe(true);
		expect(nameAllowed(p(["simon-*"]), "simon-")).toBe(true);
		expect(nameAllowed(p(["simon-*"]), "simon")).toBe(false);
		expect(nameAllowed(p(["simon-*"]), "janes-simon-x")).toBe(false);
	});

	test("star allows everything", () => {
		expect(nameAllowed(p(["*"]), "anything")).toBe(true);
	});

	test("empty list allows nothing", () => {
		expect(nameAllowed(p([]), "simon")).toBe(false);
	});
});
