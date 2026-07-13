/**
 * No Comments Extension
 *
 * Intercepts edit/write tool calls and strips code comments before
 * the file is written. Supports line comments (//, #, --, etc.),
 * block comments (/* *​/, <!-- -->, etc.), and inline comments.
 * Preserves shebangs, URLs inside strings, and regex patterns.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extname, basename } from "node:path";

// ---------------------------------------------------------------------------
// Comment style registry
// ---------------------------------------------------------------------------

interface CommentStyle {
	/** Line-comment prefixes, longest first for correct matching */
	linePrefixes: string[];
	/** Block-comment open/close pairs */
	blocks?: Array<{ open: string; close: string }>;
	
	preserveLine?: RegExp[];
	
	preserveBlock?: RegExp[];
	/** Do NOT strip inline comments on code lines (only pure-comment lines) */
	noInline?: boolean;
	stringDelimiters?: string[];
	commentPrecedingChars?: string[];
}

const SHELL_TOKEN_BOUNDARY = [" ", "\t", ";", "&", "|", "(", ")", "<", ">", "{"];
const WS_BOUNDARY = [" ", "\t"];

const STYLES: Record<string, CommentStyle> = {
	".c":   { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".cpp": { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".cxx": { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".cc":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".h":   { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".hpp": { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".hxx": { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".hh":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".m":   { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".mm":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".java": { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".kt":   { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".kts":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".scala": { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".swift": { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".cs":   { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },

	// JS / TS family
	".js":   { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }], stringDelimiters: ['"', "'", "`"] },
	".jsx":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }], stringDelimiters: ['"', "'", "`"] },
	".mjs":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }], stringDelimiters: ['"', "'", "`"] },
	".cjs":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }], stringDelimiters: ['"', "'", "`"] },
	".ts":   { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }], stringDelimiters: ['"', "'", "`"] },
	".tsx":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }], stringDelimiters: ['"', "'", "`"] },
	".mts":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }], stringDelimiters: ['"', "'", "`"] },
	".cts":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }], stringDelimiters: ['"', "'", "`"] },

	// Go
	".go": {
		linePrefixes: ["//"],
		blocks: [{ open: "/*", close: "*/" }],
		preserveLine: [
			/^\/\/go:/,
			/^\/\/line\s/,
			/^\/\/ \+build/,
			/^\/\/export\s/,
		],
		preserveBlock: [/^\/\*line\s/],
	},

	// Rust
	".rs": { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },

	// Python / Ruby / Shell / YAML
	".py":   { linePrefixes: ["#"], stringDelimiters: ['"', "'"] },
	".pyw":  { linePrefixes: ["#"], stringDelimiters: ['"', "'"] },
	".pyi":  { linePrefixes: ["#"], stringDelimiters: ['"', "'"] },
	".rb":   { linePrefixes: ["#"], blocks: [{ open: "=begin", close: "=end" }], stringDelimiters: ['"', "'"] },

	".sh":   { linePrefixes: ["#"], preserveLine: [/^#!/], stringDelimiters: ['"', "'", "`"], commentPrecedingChars: SHELL_TOKEN_BOUNDARY },
	".bash": { linePrefixes: ["#"], preserveLine: [/^#!/], stringDelimiters: ['"', "'", "`"], commentPrecedingChars: SHELL_TOKEN_BOUNDARY },
	".zsh":  { linePrefixes: ["#"], preserveLine: [/^#!/], stringDelimiters: ['"', "'", "`"], commentPrecedingChars: SHELL_TOKEN_BOUNDARY },
	".yaml": { linePrefixes: ["#"], commentPrecedingChars: WS_BOUNDARY },
	".yml":  { linePrefixes: ["#"], commentPrecedingChars: WS_BOUNDARY },
	".toml": { linePrefixes: ["#"], commentPrecedingChars: WS_BOUNDARY },
	".ini":  { linePrefixes: ["#", ";"], commentPrecedingChars: WS_BOUNDARY },
	".rl":   { linePrefixes: ["#"] },
	".r":    { linePrefixes: ["#"] },
	".pl":   { linePrefixes: ["#"] },
	".pm":   { linePrefixes: ["#"] },
	".ex":   { linePrefixes: ["#"] },
	".exs":  { linePrefixes: ["#"] },

	".sql": {
		linePrefixes: ["--"],
		blocks: [{ open: "/" + "*", close: "*" + "/" }],
		preserveLine: [
			/^--\s*name\s*:/i,
		],
	},

	// Lua
	".lua": { linePrefixes: ["--"], blocks: [{ open: "--[[", close: "]]" }] },

	// Web
	".html":  { linePrefixes: [], blocks: [{ open: "<!--", close: "-->" }] },
	".htm":   { linePrefixes: [], blocks: [{ open: "<!--", close: "-->" }] },
	".xml":   { linePrefixes: [], blocks: [{ open: "<!--", close: "-->" }] },
	".svg":   { linePrefixes: [], blocks: [{ open: "<!--", close: "-->" }] },
	".css":   { linePrefixes: [], blocks: [{ open: "/*", close: "*/" }] },
	".scss":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".less":  { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },
	".vue":   { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }, { open: "<!--", close: "-->" }] },
	".svelte": { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }, { open: "<!--", close: "-->" }] },

	// templ
	".templ": { linePrefixes: ["//"], blocks: [{ open: "/*", close: "*/" }] },

	// Markdown -- only strip HTML comments
	".md":   { linePrefixes: [], blocks: [{ open: "<!--", close: "-->" }], noInline: true },
	".mdx":  { linePrefixes: [], blocks: [{ open: "<!--", close: "-->" }], noInline: true },

	// Haskell
	".hs":   { linePrefixes: ["--"], blocks: [{ open: "{-", close: "-}" }] },
	".elm":  { linePrefixes: ["--"], blocks: [{ open: "{-", close: "-}" }] },

	// Vim
	".vim":   { linePrefixes: ['"'] },
	".vimrc": { linePrefixes: ['"'] },

	// Dockerfile / Makefile -- no extensions
};

// Extensionless filenames
const FILENAMES: Record<string, CommentStyle> = {
	"Dockerfile":  { linePrefixes: ["#"], preserveLine: [/^#!/], commentPrecedingChars: SHELL_TOKEN_BOUNDARY },
	"Makefile":    { linePrefixes: ["#"], commentPrecedingChars: WS_BOUNDARY },
	"Rakefile":    { linePrefixes: ["#"], commentPrecedingChars: WS_BOUNDARY },
	"Vagrantfile": { linePrefixes: ["#"], commentPrecedingChars: WS_BOUNDARY },
	"Gemfile":     { linePrefixes: ["#"], commentPrecedingChars: WS_BOUNDARY },
};

export function getStyle(filePath: string): CommentStyle | undefined {
	const ext = extname(filePath).toLowerCase();
	if (ext && STYLES[ext]) return STYLES[ext];
	const name = basename(filePath);
	if (FILENAMES[name]) return FILENAMES[name];
	// Dockerfile with stage suffixes: Dockerfile.prod, Dockerfile.dev
	if (name.startsWith("Dockerfile")) return FILENAMES["Dockerfile"];
	return undefined;
}

// ---------------------------------------------------------------------------
// Comment stripping engine
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}



function stripBlocks(text: string, blocks: Array<{ open: string; close: string }>, preserveBlock?: RegExp[]): string {
	let result = text;
	for (const { open, close } of blocks) {
		const re = new RegExp(`${escapeRe(open)}[\\s\\S]*?${escapeRe(close)}`, "g");
		result = result.replace(re, (match) => {
			if (preserveBlock?.some((pat) => pat.test(match))) return match;
			const nlCount = (match.match(/\n/g) || []).length;
			return "\n".repeat(nlCount);
		});
	}
	return result;
}

/**
 * Determine whether a position in `line` is inside a string literal.
 * Uses a simple heuristic: count unescaped opening/closing quotes before
 * the position.  If the count is odd, we're inside a string.
 */
function isInsideString(line: string, pos: number, delimiters: string[]): boolean {
	if (!delimiters || delimiters.length === 0) return false;

	for (const delim of delimiters) {
		let count = 0;
		let i = 0;
		while (i < pos) {
			if (line[i] === "\\" && i + 1 < line.length) {
				i += 2;
				continue;
			}
			if (line.startsWith(delim, i)) {
				count++;
				i += delim.length;
				continue;
			}
			i++;
		}
		if (count % 2 !== 0) return true;
	}
	return false;
}


function stripInlineLineComments(text: string, prefixes: string[], stringDelimiters?: string[], preserveLine?: RegExp[], precedingChars?: string[]): string {
	if (!prefixes.length) return text;
	const delims = stringDelimiters || [];

	const lines = text.split("\n");
	const result: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		// Skip lines matching preserve patterns (shebangs etc.)
		if (preserveLine?.some((re) => re.test(trimmed))) {
			result.push(line);
			continue;
		}

		let stripped = line;

		// Try each prefix (longest first for correct matching)
		for (const prefix of prefixes) {
			let searchFrom = 0;
			while (searchFrom < stripped.length) {
				const idx = stripped.indexOf(prefix, searchFrom);
				if (idx === -1) break;

				if (isInsideString(stripped, idx, delims)) {
					searchFrom = idx + prefix.length;
					continue;
				}

				if (precedingChars && precedingChars.length > 0 && idx > 0) {
					if (!precedingChars.includes(stripped[idx - 1])) {
						searchFrom = idx + prefix.length;
						continue;
					}
				}

				// Check that we're not inside a regex literal (for JS/TS)
				// Heuristic: if the character before the opening / is a known
				// regex-preceding token, skip.  This is imperfect but safe.
				if (prefix === "//" && idx > 0) {
					const before = stripped[idx - 1];
					if (before === "=" || before === "(" || before === "[" || before === "!" || before === ":" || before === ",") {
						// Likely inside a regex literal like /pattern//flags or after comparison
						searchFrom = idx + prefix.length;
						continue;
					}
				}

				// Found a genuine inline comment
				stripped = stripped.slice(0, idx).trimEnd();
				break;
			}
		}

		result.push(stripped);
	}

	return result.join("\n");
}

/** Main stripping function -- removes comments from text based on language style. */
export function stripComments(text: string, style: CommentStyle): { result: string; stripped: string[] } {
	const original = text;
	let result = text;
	const stripped: string[] = [];

	// 1. Strip block comments
	if (style.blocks?.length) {
		result = stripBlocks(result, style.blocks, style.preserveBlock);
	}

	// 2. Process line by line for pure-comment lines and inline comments
	const lines = result.split("\n");
	const kept: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		// Preserve empty lines
		if (trimmed === "") {
			kept.push(line);
			continue;
		}

		// Check preserve patterns (shebangs etc.)
		if (style.preserveLine?.some((re) => re.test(trimmed))) {
			kept.push(line);
			continue;
		}

		// Check if this is a pure comment line
		let isCommentLine = false;
		for (const prefix of style.linePrefixes) {
			if (trimmed.startsWith(prefix)) {
				isCommentLine = true;
				stripped.push(trimmed);
				break;
			}
		}

		if (isCommentLine) continue; // Drop the entire line

		kept.push(line);
	}

	result = kept.join("\n");

	// 3. Strip inline comments on code lines (unless noInline is set)
	if (!style.noInline && style.linePrefixes.length > 0) {
		result = stripInlineLineComments(result, style.linePrefixes, style.stringDelimiters, style.preserveLine, style.commentPrecedingChars);
	}

	// 4. Collapse excessive blank lines (max one blank line between content)
	result = result.replace(/\n{3,}/g, "\n\n");

	// 5. Preserve trailing newline if original had one
	if (original.endsWith("\n") && !result.endsWith("\n")) {
		result += "\n";
	}

	return { result, stripped };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function noCommentsExtension(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const filePath: string | undefined = event.input.path as string | undefined;
		if (!filePath) return;

		const style = getStyle(filePath);
		if (!style) return; // Unknown language -- leave as-is

		if (event.toolName === "edit") {
			const edits = event.input.edits;
			if (!Array.isArray(edits)) return;

			let anyStripped = false;
			const allStrippedComments: string[] = [];

			for (const edit of edits) {
				if (typeof edit.newText !== "string") continue;
				const { result, stripped } = stripComments(edit.newText, style);
				if (result !== edit.newText) {
					edit.newText = result;
					anyStripped = true;
					allStrippedComments.push(...stripped);
				}
			}

			if (anyStripped && ctx.hasUI) {
				const count = allStrippedComments.length;
				const preview = allStrippedComments.slice(0, 3).map((s) => s.slice(0, 60)).join("\n  ");
				const suffix = count > 3 ? `\n  ... and ${count - 3} more` : "";
				ctx.ui.notify(
					`🚫 Stripped ${count} comment(s) from edit`,
					"warning",
				);
				ctx.ui.setStatus("no-comments", `Stripped ${count} comment(s)`);
			}
		} else if (event.toolName === "write") {
			const content: string | undefined = event.input.content as string | undefined;
			if (typeof content !== "string") return;

			const { result, stripped } = stripComments(content, style);
			if (result !== content) {
				event.input.content = result;

				if (ctx.hasUI) {
					const count = stripped.length;
					ctx.ui.notify(
						`🚫 Stripped ${count} comment(s) from ${basename(filePath)}`,
						"warning",
					);
					ctx.ui.setStatus("no-comments", `Stripped ${count} comment(s)`);
				}
			}
		}
	});
}