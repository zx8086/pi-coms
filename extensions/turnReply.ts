// extensions/turnReply.ts
import { extractJsonPayload } from "./jsonPayload.ts";

export interface TurnReplyInbound {
	msg_id: string;
	response_schema?: object | null;
	fulfilled: boolean;
}

// Hop count for a new outbound send: one past the deepest unfulfilled inbound
// the current turn is answering, 0 when the turn was started by the user. A
// single "current inbound" slot got this wrong once prompts stacked (SIO-1611).
export function outboundHops(queue: Iterable<{ hops: number; fulfilled: boolean }>): number {
	let max = -1;
	for (const q of queue) if (!q.fulfilled && q.hops > max) max = q.hops;
	return max + 1;
}

export interface TurnReply {
	msg_id: string;
	response: unknown;
	error: string | null;
}

// One turn can cover several stacked inbound prompts (followUps merge into the
// running turn), so every unfulfilled inbound gets the turn's final assistant
// text as its reply -- oldest first, each under its own response_schema rule.
export function buildTurnReplies(
	inbounds: TurnReplyInbound[],
	lastAssistantText: string,
): TurnReply[] {
	const replies: TurnReply[] = [];
	for (const inbound of inbounds) {
		if (inbound.fulfilled) continue;
		if (inbound.response_schema && typeof inbound.response_schema === "object") {
			const parsed = extractJsonPayload(lastAssistantText);
			if (parsed === undefined) {
				replies.push({ msg_id: inbound.msg_id, response: null, error: "response not valid JSON" });
			} else {
				replies.push({ msg_id: inbound.msg_id, response: parsed, error: null });
			}
		} else {
			replies.push({ msg_id: inbound.msg_id, response: lastAssistantText, error: null });
		}
	}
	return replies;
}
