/**
 * Auto-Codegen Extension
 *
 * Automatically runs code generation after the LLM writes or edits source files,
 * so the LSP can resolve types and references immediately.
 *
 * Hooks into `tool_result` for `write`/`edit` to run codegen, then adds a
 * configurable delay so the LSP has time to index generated files.
 * Also hooks `tool_call` for the `lsp` tool to ensure the delay has fully
 * elapsed before the LSP query runs -- this guarantees fresh diagnostics.
 *
 * Supported code generators:
 *
 *   templ generate  -- .templ → .templ.go   (so gopls resolves templ components)
 *   goimports       -- .go files             (fixes imports so gopls is happy)
 *   sqlc generate   -- .sql in sqlc projects (generates Go/Python/Java DB code)
 *   buf / protoc    -- .proto files          (generates gRPC/message stubs)
 *   ogen            -- .yaml OpenAPI specs   (generates Go HTTP clients/servers)
 *   oapi-codegen    -- .yaml OpenAPI specs   (generates Go OpenAPI boilerplate)
 *
 * All generators are optional -- if a tool isn't installed, the step is skipped
 * silently. Each generator is only triggered when its project marker file exists
 * (e.g. go.mod for Go, sqlc.yaml for sqlc) to avoid running in non-matching dirs.
 *
 * Also provides a `codegen` tool for explicit generation, and a `/codegen`
 * command for interactive use.
 *
 * LSP integration:
 *   - LSP_SYNC_DELAY (default 1500ms): time to wait after codegen for the LSP
 *     to index generated files before returning control to the agent.
 *   - CODEGEN_TTL (default 5000ms): how long a codegen run is considered
 *     "recent" -- if the agent calls the lsp tool within this window, we
 *     ensure the full LSP_SYNC_DELAY has elapsed since codegen.
 *   - These are tuned for gopls + templ generate. Override via env vars:
 *       AUTO_CODEGEN_LSP_DELAY=2000  AUTO_CODEGEN_TTL=8000
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolve, extname, dirname, basename } from "node:path";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LSP_SYNC_DELAY = parseInt(process.env.AUTO_CODEGEN_LSP_DELAY ?? "1500", 10);
const CODEGEN_TTL = parseInt(process.env.AUTO_CODEGEN_TTL ?? "5000", 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const execAsync = promisify(execFile);

const availableCache = new Map<string, boolean>();

async function isAvailable(cmd: string): Promise<boolean> {
	if (availableCache.has(cmd)) return availableCache.get(cmd)!;
	try {
		await execAsync("which", [cmd]);
		availableCache.set(cmd, true);
		return true;
	} catch {
		availableCache.set(cmd, false);
		return false;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((res, rej) => {
		const timer = setTimeout(res, ms);
		timer.unref();
		if (signal) {
			const onAbort = () => { clearTimeout(timer); rej(new Error("aborted")); };
			if (signal.aborted) { clearTimeout(timer); rej(new Error("aborted")); }
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

/** Walk up from `dir` to `stopAt` looking for `filename`. */
async function findUp(filename: string, dir: string, stopAt: string = "/"): Promise<string | null> {
	let current = dir;
	while (true) {
		const candidate = resolve(current, filename);
		try {
			await stat(candidate);
			return candidate;
		} catch {}
		const parent = resolve(current, "..");
		if (parent === current || parent === stopAt) return null;
		current = parent;
	}
}

/** Check if any of the given marker files exist in the directory tree. */
async function hasMarker(dir: string, markers: string[]): Promise<string | null> {
	for (const m of markers) {
		const found = await findUp(m, dir);
		if (found) return found;
	}
	return null;
}

/** List files in a directory (non-recursive, shallow). */
async function listDir(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isFile()).map((e) => e.name);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Recent codegen tracker (module-level, shared across hooks within this extension)
// ---------------------------------------------------------------------------

/**
 * Tracks directories where codegen recently ran.
 * Key: absolute path of the project root (where the marker was found).
 * Value: timestamp (Date.now()) when codegen completed.
 */
const recentCodegenDirs = new Map<string, number>();

/** Record that codegen just completed for a project root. */
function recordCodegen(projectRoot: string): void {
	recentCodegenDirs.set(projectRoot, Date.now());

	// Prune stale entries
	const now = Date.now();
	for (const [dir, ts] of recentCodegenDirs) {
		if (now - ts > CODEGEN_TTL) recentCodegenDirs.delete(dir);
	}
}

/**
 * Check if a file path is under a recently-codegen'd project root.
 * Returns the remaining delay needed (ms) for the LSP to have caught up,
 * or 0 if no delay is needed.
 */
function remainingDelayForFile(filePath: string): number {
	const now = Date.now();
	let maxRemaining = 0;

	for (const [dir, ts] of recentCodegenDirs) {
		// Check if filePath is under this project root
		if (filePath.startsWith(dir + "/") || filePath === dir) {
			const elapsed = now - ts;
			if (elapsed < CODEGEN_TTL) {
				const remaining = LSP_SYNC_DELAY - elapsed;
				if (remaining > maxRemaining) maxRemaining = remaining;
			}
		}
	}

	return maxRemaining;
}

// ---------------------------------------------------------------------------
// Code generators
// ---------------------------------------------------------------------------

interface CodegenResult {
	ran: boolean;
	output: string;
	/** Absolute path of the project root where codegen ran. */
	projectRoot?: string;
	/** List of files that were generated or modified. */
	generatedFiles?: string[];
}

interface CodeGenerator {
	name: string;
	exts: string[];
	filenames?: string[];
	markers: string[];
	cmd: string;
	run(ctx: CodegenContext): Promise<CodegenResult>;
}

interface CodegenContext {
	filePath: string;
	dir: string;
	projectRoot: string;
	pi: ExtensionAPI;
	cwd: string;
}

const generators: CodeGenerator[] = [
	// -----------------------------------------------------------------------
	// templ -- regenerate Go code from .templ files
	// -----------------------------------------------------------------------
	{
		name: "templ generate",
		exts: [".templ"],
		markers: ["go.mod"],
		cmd: "templ",
		async run({ filePath, pi }): Promise<CodegenResult> {
			// List files before codegen to detect what was generated
			const dir = dirname(filePath);
			const before = new Set(await listDir(dir));

			const result = await pi.exec("templ", ["generate", "-f", filePath], {
				timeout: 30_000,
			});

			if (result.code !== 0) {
				// Fallback: run from project root
				const fallback = await pi.exec("templ", ["generate"], { timeout: 30_000 });
				if (fallback.code !== 0) {
					return { ran: false, output: `templ generate failed: ${result.stderr || fallback.stderr}` };
				}
			}

			// Detect generated files
			const after = await listDir(dir);
			const generated = after.filter((f) => !before.has(f));

			return {
				ran: true,
				output: `templ generate (${filePath})`,
				generatedFiles: generated.map((f) => resolve(dir, f)),
			};
		},
	},

	// -----------------------------------------------------------------------
	// goimports -- fix Go imports after editing .go files
	// -----------------------------------------------------------------------
	{
		name: "goimports",
		exts: [".go"],
		markers: ["go.mod"],
		cmd: "goimports",
		async run({ filePath, pi }): Promise<CodegenResult> {
			// Skip generated templ files -- templ generate handles those
			if (filePath.includes("_templ.go")) {
				return { ran: false, output: "skipped (_templ.go)" };
			}

			const content = await readFile(filePath, "utf-8");

			const result = await pi.exec("goimports", [], {
				input: content,
				timeout: 10_000,
			});

			if (result.code === 0 && result.stdout && result.stdout !== content) {
				await writeFile(filePath, result.stdout, "utf-8");
				return { ran: true, output: "goimports" };
			} else if (result.code === 0) {
				return { ran: true, output: "goimports (no changes)" };
			}
			return { ran: false, output: `goimports failed: ${result.stderr}` };
		},
	},

	// -----------------------------------------------------------------------
	// go mod tidy -- after editing go.mod or go.sum
	// -----------------------------------------------------------------------
	{
		name: "go mod tidy",
		exts: [".mod", ".sum"],
		filenames: ["go.mod", "go.sum"],
		markers: ["go.mod"],
		cmd: "go",
		async run({ projectRoot, pi }): Promise<CodegenResult> {
			const cwd = dirname(projectRoot);
			const result = await pi.exec("go", ["mod", "tidy"], { cwd, timeout: 60_000 });
			if (result.code === 0) {
				return { ran: true, output: "go mod tidy" };
			}
			return { ran: false, output: `go mod tidy failed: ${result.stderr}` };
		},
	},

	// -----------------------------------------------------------------------
	// sqlc generate -- generate Go/Python/Java code from SQL queries
	// -----------------------------------------------------------------------
	{
		name: "sqlc generate",
		exts: [".sql"],
		filenames: ["sqlc.yaml", "sqlc.yml"],
		markers: ["sqlc.yaml", "sqlc.yml"],
		cmd: "sqlc",
		async run({ projectRoot, pi }): Promise<CodegenResult> {
			const cwd = dirname(projectRoot);
			const result = await pi.exec("sqlc", ["generate"], {
				cwd,
				timeout: 30_000,
			});
			if (result.code === 0) {
				return { ran: true, output: "sqlc generate", projectRoot: cwd };
			}
			return { ran: false, output: `sqlc generate failed: ${result.stderr}` };
		},
	},

	// -----------------------------------------------------------------------
	// buf generate -- protobuf code generation via buf
	// -----------------------------------------------------------------------
	{
		name: "buf generate",
		exts: [".proto"],
		markers: ["buf.yaml", "buf.gen.yaml", "buf.lock"],
		cmd: "buf",
		async run({ projectRoot, pi }): Promise<CodegenResult> {
			const cwd = dirname(projectRoot);
			const result = await pi.exec("buf", ["generate"], { cwd, timeout: 30_000 });
			if (result.code === 0) {
				return { ran: true, output: "buf generate", projectRoot: cwd };
			}
			return { ran: false, output: `buf generate failed: ${result.stderr}` };
		},
	},

	// -----------------------------------------------------------------------
	// protoc -- fallback protobuf code generation via go generate
	// -----------------------------------------------------------------------
	{
		name: "protoc (go generate)",
		exts: [".proto"],
		markers: ["Makefile", "generate.go"],
		cmd: "protoc",
		async run({ projectRoot, pi }): Promise<CodegenResult> {
			const cwd = dirname(projectRoot);
			const result = await pi.exec("go", ["generate", "./..."], { cwd, timeout: 60_000 });
			if (result.code === 0) {
				return { ran: true, output: "go generate", projectRoot: cwd };
			}
			return { ran: false, output: `go generate failed: ${result.stderr}` };
		},
	},

	// -----------------------------------------------------------------------
	// ogen -- OpenAPI Go generator
	// -----------------------------------------------------------------------
	{
		name: "ogen generate",
		exts: [".yaml", ".yml", ".json"],
		filenames: ["openapi.yaml", "openapi.yml", "swagger.yaml", "swagger.yml", "openapi.json"],
		markers: ["ogen.yaml", "ogen.yml", ".ogen.yaml"],
		cmd: "ogen",
		async run({ projectRoot, pi }): Promise<CodegenResult> {
			const cwd = dirname(projectRoot);
			const result = await pi.exec("ogen", ["generate"], { cwd, timeout: 30_000 });
			if (result.code === 0) {
				return { ran: true, output: "ogen generate", projectRoot: cwd };
			}
			return { ran: false, output: `ogen generate failed: ${result.stderr}` };
		},
	},

	// -----------------------------------------------------------------------
	// oapi-codegen -- OpenAPI Go code generator
	// -----------------------------------------------------------------------
	{
		name: "oapi-codegen",
		exts: [".yaml", ".yml"],
		filenames: ["openapi.yaml", "openapi.yml", "swagger.yaml", "swagger.yml"],
		markers: ["oapi-codegen.yaml", "oapi-codegen.yml"],
		cmd: "oapi-codegen",
		async run({ projectRoot, pi }): Promise<CodegenResult> {
			const cwd = dirname(projectRoot);
			const result = await pi.exec("oapi-codegen", ["--config", "oapi-codegen.yaml", "openapi.yaml"], {
				cwd,
				timeout: 30_000,
			});
			if (result.code === 0) {
				return { ran: true, output: "oapi-codegen", projectRoot: cwd };
			}
			return { ran: false, output: `oapi-codegen failed: ${result.stderr}` };
		},
	},
];

// Build lookup maps
const extToGenerators = new Map<string, CodeGenerator[]>();
const filenameToGenerators = new Map<string, CodeGenerator[]>();

for (const g of generators) {
	for (const ext of g.exts) {
		const list = extToGenerators.get(ext) ?? [];
		list.push(g);
		extToGenerators.set(ext, list);
	}
	for (const fn of g.filenames ?? []) {
		const list = filenameToGenerators.get(fn) ?? [];
		list.push(g);
		filenameToGenerators.set(fn, list);
	}
}

// ---------------------------------------------------------------------------
// Core codegen logic
// ---------------------------------------------------------------------------

async function runCodegen(
	filePath: string,
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
): Promise<CodegenResult[]> {
	const ext = extname(filePath).toLowerCase();
	const base = basename(filePath);
	const dir = dirname(filePath);

	const candidates: CodeGenerator[] = [];

	if (extToGenerators.has(ext)) candidates.push(...extToGenerators.get(ext)!);
	if (filenameToGenerators.has(base)) candidates.push(...filenameToGenerators.get(base)!);

	if (candidates.length === 0) return [];

	const results: CodegenResult[] = [];

	for (const gen of candidates) {
		if (signal?.aborted) break;
		if (!(await isAvailable(gen.cmd))) continue;

		const markerPath = await hasMarker(dir, gen.markers);
		if (!markerPath) continue;

		// Skip templ-generated .go files
		if (ext === ".go" && filePath.includes("_templ.go")) continue;

		const projectRoot = dirname(markerPath);

		try {
			const result = await gen.run({ filePath, dir, projectRoot, pi, cwd });
			result.projectRoot = projectRoot;
			results.push(result);

			// Record codegen activity and wait for LSP sync
			if (result.ran) {
				recordCodegen(projectRoot);
				await sleep(LSP_SYNC_DELAY, signal);
			}
		} catch (err: any) {
			results.push({ ran: false, output: `${gen.name} error: ${err.message}` });
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// Auto-codegen after write/edit tool results
	// -----------------------------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (event.isError) return;

		const input = event.input as { path?: string };
		if (!input?.path) return;

		const filePath = resolve(ctx.cwd, input.path.replace(/^@/, ""));
		const results = await runCodegen(filePath, pi, ctx.cwd, ctx.signal);

		// Return new content array with codegen results appended
		const ran = results.filter((r) => r.ran);
		if (ran.length > 0) {
			const lines = ran.map((r) => r.output).join(", ");
			return {
				content: [
					...event.content,
					{ type: "text" as const, text: `[auto-codegen] Ran: ${lines}` },
				],
			};
		}

		// Log failures to console (don't pollute LLM context)
		const failed = results.filter((r) => !r.ran);
		for (const f of failed) {
			console.error(`[auto-codegen] ${f.output}`);
		}
	});

	// -----------------------------------------------------------------------
	// Ensure LSP sync before lsp tool calls
	// -----------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "lsp") return;

		const input = event.input as { file?: string; files?: string[] };
		const files: string[] = [];
		if (input?.file) files.push(input.file);
		if (Array.isArray(input?.files)) files.push(...input.files);

		if (files.length === 0) return;

		// Check if any of the queried files are in a recently-codegen'd project
		let maxDelay = 0;
		for (const f of files) {
			const filePath = resolve(ctx.cwd, f.replace(/^@/, ""));
			const delay = remainingDelayForFile(filePath);
			if (delay > maxDelay) maxDelay = delay;
		}

		if (maxDelay > 0) {
			console.log(`[auto-codegen] Waiting ${maxDelay}ms for LSP sync before query`);
			await sleep(maxDelay, ctx.signal);
		}
	});

	// -----------------------------------------------------------------------
	// Manual `codegen` tool for explicit code generation
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "codegen",
		label: "Codegen",
		description:
			"Run code generation for a file or project. Automatically detects " +
			"the right generator based on file type and project structure. " +
			"Supports: templ (templ generate), Go (goimports, go mod tidy), sqlc, buf/protoc, ogen, oapi-codegen. " +
			"Use after editing source files to regenerate output so the LSP resolves types.",
		promptSnippet: "Run code generation for a file or project",
		promptGuidelines: [
			"Use `codegen` after editing .templ files so the Go LSP can resolve component types.",
			"Use `codegen` after editing .sql files in sqlc projects to regenerate database code.",
			"Use `codegen` after editing .proto files to regenerate gRPC/message stubs.",
			"Use `codegen` after editing .go files to fix imports with goimports.",
			"Use `codegen` after editing go.mod or go.sum to run go mod tidy.",
		],
		parameters: Type.Object({
			path: Type.String({
				description: "File or directory to run code generation for",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
			const results = await runCodegen(filePath, pi, ctx.cwd, signal);

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No code generator matched for ${filePath}. ` +
								`Supported: .templ → templ generate, .go → goimports, ` +
								`.sql → sqlc, .proto → buf/protoc, go.mod → go mod tidy`,
						},
					],
				};
			}

			const lines = results.map((r) =>
				r.ran ? `✓ ${r.output}` : `✗ ${r.output}`,
			);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		},
	});

	// -----------------------------------------------------------------------
	// /codegen command for interactive use
	// -----------------------------------------------------------------------
	pi.registerCommand("codegen", {
		description: "Run code generation for a file (usage: /codegen <path>)",
		handler: async (args, ctx) => {
			const path = args?.trim();
			if (!path) {
				ctx.ui.notify("Usage: /codegen <file-or-directory>", "warning");
				return;
			}

			ctx.ui.setStatus("codegen", `Running codegen for ${path}...`);
			const filePath = resolve(ctx.cwd, path.replace(/^@/, ""));
			const results = await runCodegen(filePath, pi, ctx.cwd);
			ctx.ui.setStatus("codegen", undefined);

			if (results.length === 0) {
				ctx.ui.notify(`No code generator matched for ${path}`, "warning");
				return;
			}

			for (const r of results) {
				if (r.ran) {
					ctx.ui.notify(`✓ ${r.output}`, "info");
				} else {
					ctx.ui.notify(`✗ ${r.output}`, "error");
				}
			}
		},
	});
}
