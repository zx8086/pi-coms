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

	// SIO-1635: the incident analyzer service principal registers a fresh
	// suffixed name per request, so its directory entry is the prefix pattern.
	test("service principal prefix covers per-request suffixes only", () => {
		const svc = { principal: "incident-analyzer", kind: "service", names: ["incident-analyzer-*"] };
		expect(nameAllowed(svc, "incident-analyzer-0f1e2d3c")).toBe(true);
		expect(nameAllowed(svc, "incident-analyzer")).toBe(false);
		expect(nameAllowed(svc, "eu-oit-dev")).toBe(false);
		expect(nameAllowed(svc, "ops")).toBe(false);
	});

	test("star allows everything", () => {
		expect(nameAllowed(p(["*"]), "anything")).toBe(true);
	});

	test("empty list allows nothing", () => {
		expect(nameAllowed(p([]), "simon")).toBe(false);
	});
});
