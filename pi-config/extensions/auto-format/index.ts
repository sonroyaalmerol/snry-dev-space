/**
 * Auto-Format Extension
 *
 * Automatically formats files after the LLM writes or edits them.
 * Hooks into `tool_result` for the `write` and `edit` tools and runs
 * the appropriate formatter based on file extension.
 *
 * Supported formatters (must be installed on the system):
 *   - Prettier: JS, TS, JSX, TSX, CSS, SCSS, HTML, JSON, YAML, Markdown, Vue, Svelte, GraphQL
 *   - gofmt: Go
 *   - rustfmt: Rust
 *   - shfmt: Shell scripts (install via: go install mvdan.cc/sh/v3/cmd/shfmt@latest)
 *   - black: Python (install via: pip install black)
 *   - stylua: Lua (install via: cargo install stylua)
 *   - zig fmt: Zig
 *   - dart format: Dart
 *   - mix format: Elixir
 *   - crystal tool format: Crystal
 *   - clang-format: C, C++, Objective-C
 *
 * If a formatter isn't found, the file is left as-is (no error thrown).
 *
 * The extension also provides a `format` tool so the LLM can explicitly
 * request formatting, and a `/format` command for interactive use.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolve, extname } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Formatter registry
// ---------------------------------------------------------------------------

interface Formatter {
	/** The command to run (resolved from PATH) */
	cmd: string;
	/** Arguments passed before the file path */
	args: string[];
	/** File extensions (with dot, lowercase) this formatter handles */
	exts: string[];
	/** If true, formatter reads stdin and outputs to stdout */
	stdinMode?: boolean;
}

const FORMATTERS: Formatter[] = [
	// Prettier handles a huge range of languages
	{
		cmd: "prettier",
		args: ["--write", "--log-level", "error"],
		exts: [
			".js", ".jsx", ".mjs", ".cjs",
			".ts", ".tsx", ".mts", ".cts",
			".css", ".scss", ".less",
			".html", ".htm",
			".json", ".json5",
			".yml", ".yaml",
			".md", ".mdx",
			".vue", ".svelte",
			".graphql", ".gql",
			".toml",
		],
	},
	{ cmd: "gofmt", args: ["-w"], exts: [".go"] },
	{ cmd: "rustfmt", args: ["--edition", "2021"], exts: [".rs"], stdinMode: true },
	{ cmd: "shfmt", args: ["-w", "-i", "0", "-ci"], exts: [".sh", ".bash", ".zsh"] },
	{ cmd: "black", args: ["--quiet", "-"], exts: [".py", ".pyw"], stdinMode: true },
	{ cmd: "stylua", args: ["-"], exts: [".lua"], stdinMode: true },
	{ cmd: "zig", args: ["fmt", "--stdin"], exts: [".zig"], stdinMode: true },
	{ cmd: "dart", args: ["format"], exts: [".dart"] },
	{ cmd: "mix", args: ["format"], exts: [".ex", ".exs"] },
	{ cmd: "crystal", args: ["tool", "format"], exts: [".cr"] },
	{ cmd: "clang-format", args: ["-i"], exts: [".c", ".cpp", ".cxx", ".cc", ".h", ".hpp", ".hxx", ".hh", ".m", ".mm"] },
];

// Build extension → formatter map for O(1) lookup
const extMap = new Map<string, Formatter>();
for (const f of FORMATTERS) {
	for (const ext of f.exts) {
		extMap.set(ext, f);
	}
}

// Cache which commands are available (populated lazily)
const available = new Map<string, boolean>();

async function isAvailable(cmd: string): Promise<boolean> {
	if (available.has(cmd)) return available.get(cmd)!;
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execAsync = promisify(execFile);
	try {
		await execAsync("which", [cmd]);
		available.set(cmd, true);
		return true;
	} catch {
		available.set(cmd, false);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Core formatting logic
// ---------------------------------------------------------------------------

async function formatFile(
	filePath: string,
	pi: ExtensionAPI,
): Promise<{ formatted: boolean; output: string }> {
	const ext = extname(filePath).toLowerCase();
	const formatter = extMap.get(ext);
	if (!formatter) {
		return { formatted: false, output: `No formatter configured for ${ext || "unknown extension"}` };
	}

	if (!(await isAvailable(formatter.cmd))) {
		return { formatted: false, output: `${formatter.cmd} not found on PATH` };
	}

	try {
		if (formatter.stdinMode) {
			// Read file, pipe through stdin, capture stdout, write back
			const content = await readFile(filePath, "utf-8");
			const result = await pi.exec(formatter.cmd, [...formatter.args], {
				input: content,
				timeout: 10_000,
			});
			if (result.code === 0 && result.stdout) {
				await writeFile(filePath, result.stdout, "utf-8");
				return { formatted: true, output: `Formatted with ${formatter.cmd}` };
			} else {
				return { formatted: false, output: `${formatter.cmd} failed: ${result.stderr || result.stdout}` };
			}
		} else {
			// File-based formatters modify in-place
			const result = await pi.exec(formatter.cmd, [...formatter.args, filePath], {
				timeout: 10_000,
			});
			if (result.code === 0) {
				return { formatted: true, output: `Formatted with ${formatter.cmd}` };
			} else {
				return { formatted: false, output: `${formatter.cmd} failed: ${result.stderr || result.stdout}` };
			}
		}
	} catch (err: any) {
		return { formatted: false, output: `${formatter.cmd} error: ${err.message}` };
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// Auto-format after write/edit tool results
	// -----------------------------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (event.isError) return; // Don't try to format if the tool failed

		const input = event.input as { path?: string };
		if (!input?.path) return;

		const filePath = resolve(ctx.cwd, input.path.replace(/^@/, ""));
		const ext = extname(filePath).toLowerCase();
		if (!extMap.has(ext)) return; // No formatter for this file type

		const result = await formatFile(filePath, pi);

		if (result.formatted) {
			// Return new content array with formatting info appended
			return {
				content: [
					...event.content,
					{ type: "text" as const, text: `[auto-format] ${result.output}` },
				],
			};
		}
		// Silently skip if formatter unavailable -- don't pollute errors
	});

	// -----------------------------------------------------------------------
	// Manual `format` tool for explicit formatting requests
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "format",
		label: "Format",
		description:
			"Format a file using the appropriate formatter for its language. " +
			"Supports: JS/TS (prettier), Go (gofmt), Rust (rustfmt), Python (black), " +
			"Shell (shfmt), C/C++ (clang-format), and more. " +
			"Also accepts directories to format all supported files recursively.",
		promptSnippet: "Format a file or directory",
		promptGuidelines: [
			"Use the `format` tool when asked to format, lint-fix, or clean up code indentation/style.",
			"Prefer `format` over manual indentation fixes.",
		],
		parameters: Type.Object({
			path: Type.String({
				description: "File or directory path to format",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
			const ext = extname(filePath).toLowerCase();

			// Single file
			if (ext) {
				const formatter = extMap.get(ext);
				if (!formatter) {
					return {
						content: [{ type: "text", text: `No formatter configured for ${ext} files.` }],
					};
				}

				const result = await formatFile(filePath, pi);
				if (result.formatted) {
					return {
						content: [{ type: "text", text: `✓ ${result.output}` }],
					};
				} else {
					throw new Error(result.output);
				}
			}

			// Directory -- use prettier if available, otherwise error
			if (!(await isAvailable("prettier"))) {
				throw new Error("Directory formatting requires prettier. Install with: npm i -g prettier");
			}
			const result = await pi.exec("prettier", ["--write", "--log-level", "warn", filePath], {
				signal,
				timeout: 30_000,
			});
			if (result.code === 0) {
				const output = result.stdout || result.stderr || "Formatted directory";
				return {
					content: [{ type: "text", text: `✓ ${output}` }],
				};
			} else {
				throw new Error(`prettier failed: ${result.stderr || result.stdout}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// /format command for interactive use
	// -----------------------------------------------------------------------
	pi.registerCommand("format", {
		description: "Format a file (usage: /format <path>)",
		handler: async (args, ctx) => {
			const path = args?.trim();
			if (!path) {
				ctx.ui.notify("Usage: /format <file-or-directory>", "warning");
				return;
			}
			const filePath = resolve(ctx.cwd, path.replace(/^@/, ""));
			const ext = extname(filePath).toLowerCase();

			if (!ext) {
				ctx.ui.notify("Please specify a file (directory formatting via /format not supported)", "warning");
				return;
			}

			const formatter = extMap.get(ext);
			if (!formatter) {
				ctx.ui.notify(`No formatter configured for ${ext} files`, "warning");
				return;
			}

			ctx.ui.setStatus("format", `Formatting ${path}...`);
			const result = await formatFile(filePath, pi);
			ctx.ui.setStatus("format", undefined);

			if (result.formatted) {
				ctx.ui.notify(`✓ ${result.output}`, "info");
			} else {
				ctx.ui.notify(`✗ ${result.output}`, "error");
			}
		},
	});
}
