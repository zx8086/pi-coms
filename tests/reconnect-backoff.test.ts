// tests/reconnect-backoff.test.ts
import { expect, test } from "bun:test";
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, reconnectDelay } from "../extensions/reconnectBackoff.ts";

// random() = 0.5 removes the jitter: delay equals the base.
const noJitter = { random: () => 0.5 };

test("doubles from the base on every attempt", () => {
	expect([0, 1, 2, 3].map((n) => reconnectDelay(n, noJitter).delayMs)).toEqual([500, 1000, 2000, 4000]);
	expect(RECONNECT_BASE_MS).toBe(500);
});

test("caps the base at the ceiling and flags it", () => {
	expect(reconnectDelay(4, noJitter)).toEqual({ delayMs: 8000, atCeiling: false });
	expect(reconnectDelay(5, noJitter)).toEqual({ delayMs: RECONNECT_MAX_MS, atCeiling: true });
	expect(reconnectDelay(50, noJitter)).toEqual({ delayMs: RECONNECT_MAX_MS, atCeiling: true });
});

test("jitter spreads the delay across 0.5x to 1.5x of the base", () => {
	expect(reconnectDelay(1, { random: () => 0 }).delayMs).toBe(500);
	expect(reconnectDelay(1, { random: () => 1 }).delayMs).toBe(1500);
	// Two clients with different random draws never wait the same time.
	expect(reconnectDelay(3, { random: () => 0.1 }).delayMs).not.toBe(reconnectDelay(3, { random: () => 0.9 }).delayMs);
});

test("stays within bounds with the real random source", () => {
	for (let i = 0; i < 200; i++) {
		const { delayMs } = reconnectDelay(2);
		expect(delayMs).toBeGreaterThanOrEqual(1000);
		expect(delayMs).toBeLessThanOrEqual(3000);
	}
});

test("custom base and ceiling are honoured and a negative attempt counts as zero", () => {
	expect(reconnectDelay(-3, { ...noJitter, baseMs: 100, maxMs: 250 })).toEqual({ delayMs: 100, atCeiling: false });
	expect(reconnectDelay(2, { ...noJitter, baseMs: 100, maxMs: 250 })).toEqual({ delayMs: 250, atCeiling: true });
});
