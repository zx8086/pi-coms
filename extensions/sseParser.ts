// extensions/sseParser.ts -- shared module (not an extension), no deps

export type SseHandler = (event: string, data: unknown, id?: string) => void;

export interface SseParser {
	feed(chunk: Uint8Array | string): void;
}

// Hand-rolled text/event-stream frame parser. Frames end at a blank line;
// "data:" lines join with "\n" and are JSON-parsed when they can be, otherwise
// the raw string is handed over. Handler errors never break the stream.
export function makeSseParser(onEvent: SseHandler): SseParser {
	const decoder = new TextDecoder("utf-8");
	let buf = "";
	return {
		feed(chunk: Uint8Array | string): void {
			buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
			let idx: number;
			while ((idx = buf.indexOf("\n\n")) >= 0) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				let event = "message";
				const dataLines: string[] = [];
				let id: string | undefined;
				for (const line of frame.split("\n")) {
					if (line.length === 0) continue;
					if (line.startsWith(":")) continue; // SSE comment
					if (line.startsWith("event:")) {
						event = line.slice(6).trimStart();
					} else if (line.startsWith("data:")) {
						let v = line.slice(5);
						if (v.startsWith(" ")) v = v.slice(1);
						dataLines.push(v);
					} else if (line.startsWith("id:")) {
						id = line.slice(3).trimStart();
					}
				}
				if (dataLines.length > 0) {
					const joined = dataLines.join("\n");
					let data: unknown = joined;
					try { data = JSON.parse(joined); } catch { /* keep as string */ }
					try { onEvent(event, data, id); } catch { /* ignore handler errors */ }
				}
			}
		},
	};
}
