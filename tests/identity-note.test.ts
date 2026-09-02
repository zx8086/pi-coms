// tests/identity-note.test.ts
//
// SIO-1600: agents guess their own coms name and mislabel themselves in
// replies (a spoke calling itself monitor-<name>). The extension knows the
// registered name; this note hands it to the model so it never has to guess.
import { expect, test } from "bun:test";
import { buildIdentityNote } from "../extensions/identityNote";

test("names the agent so it does not have to guess", () => {
	const note = buildIdentityNote("eu-oit-dev");
	expect(note).toContain("eu-oit-dev");
});

test("tells the agent to use exactly that name when identifying itself", () => {
	const note = buildIdentityNote("eu-oit-dev").toLowerCase();
	expect(note).toContain("exactly");
	expect(note).toContain("identify");
});

test("directs account id to sts, not memory", () => {
	const note = buildIdentityNote("eu-oit-dev");
	expect(note).toContain("sts");
});

test("uses the post-registration name, including a hub-renamed one", () => {
	// The hub auto-suffixes on collision (laptop -> laptop2); the note must
	// carry whatever name registration resolved, not the desired flag.
	const note = buildIdentityNote("eu-oit-dev2");
	expect(note).toContain("eu-oit-dev2");
	expect(note).not.toContain("eu-oit-dev "); // no bare un-suffixed name
});

test("does not restate ping formats or other conventions", () => {
	// Keep it to the identity fact; ping-format guidance lives elsewhere.
	const note = buildIdentityNote("eu-oit-dev").toLowerCase();
	expect(note).not.toContain("pong");
	expect(note).not.toContain("coms_net_list");
});
