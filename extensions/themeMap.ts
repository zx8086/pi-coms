// extensions/themeMap.ts
//
// Shared helper (not an extension): per-extension default theme and terminal
// title. Theme JSON lives in ~/.pi/agent/themes/<name>.json.
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "path";
import { fileURLToPath } from "url";

// Key = extension filename without extension; value = theme name.
export const THEME_MAP: Record<string, string> = {
	"coms-net": "github-dark-default",
	minimal: "synthwave",
};

const FALLBACK_THEME = "synthwave";

function extensionName(fileUrl: string): string {
	const filePath = fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
	return basename(filePath).replace(/\.[^.]+$/, "");
}

// The first -e / --extension on the command line. Stacked extensions all fire
// session_start; only the primary one may set the theme, and the title is
// derived from argv so every extension computes the same value.
function primaryExtensionName(): string | null {
	const argv = process.argv;
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") {
			return basename(argv[i + 1]).replace(/\.[^.]+$/, "");
		}
	}
	return null;
}

function applyExtensionTheme(fileUrl: string, ctx: ExtensionContext): boolean {
	if (!ctx.hasUI) return false;
	const name = extensionName(fileUrl);
	const primaryExt = primaryExtensionName();
	if (primaryExt && primaryExt !== name) return true;
	const themeName = THEME_MAP[name] ?? FALLBACK_THEME;
	const result = ctx.ui.setTheme(themeName);
	if (!result.success && themeName !== FALLBACK_THEME) {
		return ctx.ui.setTheme(FALLBACK_THEME).success;
	}
	return result.success;
}

// Deferred 150 ms to fire after Pi's own startup title-set.
function applyExtensionTitle(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const name = primaryExtensionName();
	if (!name) return;
	setTimeout(() => ctx.ui.setTitle(`π - ${name}`), 150);
}

// Call from every extension's session_start: applyExtensionDefaults(import.meta.url, ctx).
export function applyExtensionDefaults(fileUrl: string, ctx: ExtensionContext): void {
	applyExtensionTheme(fileUrl, ctx);
	applyExtensionTitle(ctx);
}
