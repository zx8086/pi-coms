// extensions/turnReply.ts
import { extractJsonPayload } from "./jsonPayload.ts";

export interface TurnReplyInbound {
	msg_id: string;
	response_schema?: object | null;
	fulfilled: boolean;
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
