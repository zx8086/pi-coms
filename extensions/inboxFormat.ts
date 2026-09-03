// extensions/inboxFormat.ts
export type InboxMessage = {
	msg_id: string;
	sender_name: string;
	status: string;
	created_at: string;
	prompt: string;
	response?: unknown;
	error?: string | null;
};

export const INBOX_PREVIEW_CHARS = 2000;

const indent = (s: string): string => s.replace(/\n/g, "\n  ");

// A completed conversation carries the reply (or the failure) under the prompt.
const replyOf = (m: InboxMessage, full: boolean): string => {
	if (m.error) return `\n  reply: (${m.error})`;
	if (m.response == null) return "";
	const text = typeof m.response === "string" ? m.response : JSON.stringify(m.response);
	const shown = full || text.length <= INBOX_PREVIEW_CHARS ? text : text.slice(0, INBOX_PREVIEW_CHARS) + " …";
	return `\n  reply: ${indent(shown)}`;
};

const entry = (m: InboxMessage, body: string, full = false): string =>
	`[${m.created_at}] from ${m.sender_name} (${m.status}) msg_id ${m.msg_id}\n  ${indent(body)}${replyOf(m, full)}`;

export function formatInbox(
	name: string,
	messages: InboxMessage[],
	opts: { msgId?: string } = {},
): string {
	if (opts.msgId) {
		const m = messages.find((x) => x.msg_id === opts.msgId);
		if (!m) {
			return `msg_id ${opts.msgId} not found in the ${messages.length} message(s) fetched from inbox "${name}"; widen the fetch with limit or since.`;
		}
		return `Inbox "${name}" msg_id ${m.msg_id} (full body):\n\n${entry(m, m.prompt, true)}`;
	}
	if (messages.length === 0) return `Inbox "${name}" is empty.`;
	const lines = messages.map((m) => {
		const preview = m.prompt.slice(0, INBOX_PREVIEW_CHARS);
		const cut = m.prompt.length > INBOX_PREVIEW_CHARS ? " …" : "";
		return entry(m, preview + cut);
	});
	return `Inbox "${name}": ${messages.length} message(s)\n\n${lines.join("\n\n")}`;
}
