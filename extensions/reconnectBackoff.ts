// extensions/reconnectBackoff.ts

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 10_000;

export interface ReconnectDelay {
	delayMs: number;
	// The un-jittered base reached the cap: the caller warns the operator once.
	atCeiling: boolean;
}

// Exponential backoff with 0.5x to 1.5x jitter. The hub is a single instance,
// so after a hub restart the whole fleet must not retry in lockstep (SIO-1613).
export function reconnectDelay(
	attempt: number,
	opts: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): ReconnectDelay {
	const baseMs = opts.baseMs ?? RECONNECT_BASE_MS;
	const maxMs = opts.maxMs ?? RECONNECT_MAX_MS;
	const random = opts.random ?? Math.random;
	const base = Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
	return { delayMs: Math.round(base * (0.5 + random())), atCeiling: base >= maxMs };
}
