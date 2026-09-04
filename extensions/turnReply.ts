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
export function buildTurnReplies(inbounds: TurnReplyInbound[], lastAssistantText: string): TurnReply[] {
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

// Pi's AgentMessage union includes entries without content (bash execution).
export interface TurnMessage {
	role: string;
	content?: unknown;
}

// The final assistant text of a run: the latest assistant message wins, text
// blocks join with "\n", thinking and tool-call blocks are not part of a reply.
export function lastAssistantText(messages: Iterable<TurnMessage>): string {
	let text = "";
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.filter(
					(b): b is { type: "text"; text: string } =>
						!!b &&
						typeof b === "object" &&
						(b as { type?: unknown }).type === "text" &&
						typeof (b as { text?: unknown }).text === "string",
				)
				.map((b) => b.text)
				.join("\n");
		}
	}
	return text;
}

// Build the replies and take their entries out of the queue in one step, so
// a second agent_end for the same turn cannot submit them again (SIO-1611).
export function claimTurnReplies<T extends TurnReplyInbound>(queue: Map<string, T>, text: string): TurnReply[] {
	const replies = buildTurnReplies([...queue.values()], text);
	for (const reply of replies) {
		const inbound = queue.get(reply.msg_id);
		if (inbound) inbound.fulfilled = true;
		queue.delete(reply.msg_id);
	}
	return replies;
}
