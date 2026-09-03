// extensions/inboxFormat.ts
export type InboxMessage = {
	msg_id: string;
	sender_name: string;
	status: string;
	created_at: string;
	prompt: string;
};

export const INBOX_PREVIEW_CHARS = 2000;

const entry = (m: InboxMessage, body: string): string =>
	`[${m.created_at}] from ${m.sender_name} (${m.status}) msg_id ${m.msg_id}\n  ${body.replace(/\n/g, "\n  ")}`;

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
		return `Inbox "${name}" msg_id ${m.msg_id} (full body):\n\n${entry(m, m.prompt)}`;
	}
	if (messages.length === 0) return `Inbox "${name}" is empty.`;
	const lines = messages.map((m) => {
		const preview = m.prompt.slice(0, INBOX_PREVIEW_CHARS);
		const cut = m.prompt.length > INBOX_PREVIEW_CHARS ? " …" : "";
		return entry(m, preview + cut);
	});
	return `Inbox "${name}": ${messages.length} message(s)\n\n${lines.join("\n\n")}`;
}
