// extensions/jsonPayload.ts -- shared module (not an extension), no deps

// Schema-constrained replies rarely arrive as bare JSON: models wrap the
// payload in a markdown fence or add prose around it. Try strict parse, then
// the first fenced block, then the first balanced object/array. Returns
// undefined when nothing in the text parses.
export function extractJsonPayload(text: string): unknown {
	const t = text.trim();
	try {
		return JSON.parse(t);
	} catch { /* fall through */ }
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) {
		try {
			return JSON.parse(fence[1].trim());
		} catch { /* fall through */ }
	}
	for (const open of ["{", "["] as const) {
		const close = open === "{" ? "}" : "]";
		const start = t.indexOf(open);
		if (start < 0) continue;
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let i = start; i < t.length; i++) {
			const c = t[i];
			if (inStr) {
				if (esc) esc = false;
				else if (c === "\\") esc = true;
				else if (c === '"') inStr = false;
				continue;
			}
			if (c === '"') inStr = true;
			else if (c === open) depth++;
			else if (c === close) {
				depth--;
				if (depth === 0) {
					try {
						return JSON.parse(t.slice(start, i + 1));
					} catch { /* try the other delimiter */ }
					break;
				}
			}
		}
	}
	return undefined;
}
