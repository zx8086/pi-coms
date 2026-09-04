// scripts/monitor/errors.ts

// Same result as the old `e?.message ?? e` on an untyped catch value: an
// Error's message, a message-bearing object's message, else the value itself.
export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === "object" && e !== null && "message" in e && e.message != null) return String(e.message);
	return String(e);
}
