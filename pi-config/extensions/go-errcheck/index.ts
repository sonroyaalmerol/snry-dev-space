import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, dirname, relative } from "node:path";
import { existsSync } from "node:fs";

const exec = promisify(execFile);

function isGoFile(path: string): boolean {
	return typeof path === "string" && extname(path) === ".go";
}

function findGoModuleDir(start: string): string | null {
	let dir = start;
	for (let i = 0; i < 20; i++) {
		if (existsSync(dir + "/go.mod")) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

const IGNORED_SUFFIXES = ["_test.go", ".sql.go", ".ab.go"];
const IGNORED_FILE_PATTERNS = [/_test\.go/, /\.sql\.go\b/, /\bkube_/i, /\.pb\.go\b/, /\.ab\.go\b/];

const IDIOMATIC_LINE_PATTERNS = [
	/\bdefer\s+\S+\.Close\(\)/,
	/\bdefer\s+func\(\)\s*\{\s*_\s*=\s/,
	/\bdefer\s+\S+\.Flush\(\)/,
	/\b_\s*=\s+\S+\.Close\(/,
	/\b_\s*=\s+\S+\.CloseWithError\(/,
	/\b_,\s*_\s*=\s+\S+\.Write\(/,
	/\b_\s*=\s+\S+\.Set(?:Read|Write)?Deadline\(/,
	/\b_\s*=\s+os\.Remove\(/,
	/\bfmt\.(Println?|Printf|Fprint|Fprintf|Sprint|Sprintf|Fprintln?|Sprintln?)\b/,
	/\bjson\.NewEncoder\(/,
	/\bio\.WriteString\(/,
	/\bio\.Copy\(\w/,
	/\bio\.CopyBuffer\(/,
];

function isIgnoredGoFile(path: string): boolean {
	if (IGNORED_SUFFIXES.some((s) => path.endsWith(s))) return true;
	if (/\b(sqlc\/|sqlc_gen\/|buf\/gen\/|\.gen\.go|\.generated\.go)/i.test(path)) return true;
	return false;
}

function isIdiomaticNoCheck(line: string): boolean {
	const trimmed = line.replace(/^.*:\d+:\d:\t/, "");
	if (/(?:\bbuffer|\bbuilder|\bbuf|\bbldr|\bbufw)\.Write(?:String|Byte|Rune)?\(/.test(trimmed)) return true;
	if (/(?:\bbuffer|\bbuilder|\bbuf|\bbldr|\bbufw)\.ReadFrom\(/.test(trimmed)) return true;
	if (/\.Write\(.*\)\s*$/.test(trimmed) && /\b(?:hash|hasher|mac|hmac)\./.test(trimmed)) return true;
	return false;
}

function filterIgnoredOutput(output: string): string {
	return output
		.split("\n")
		.filter((line) => !IGNORED_FILE_PATTERNS.some((p) => p.test(line)))
		.filter((line) => !IDIOMATIC_LINE_PATTERNS.some((p) => p.test(line)))
		.filter((line) => !isIdiomaticNoCheck(line))
		.join("\n")
		.trim();
}

async function runGoVet(pkgDir: string, signal?: AbortSignal): Promise<string> {
	try {
		const { stdout, stderr } = await exec("go", ["vet", "./..."], {
			cwd: pkgDir,
			timeout: 60_000,
			signal,
		});
		return filterIgnoredOutput((stderr || stdout || "").trim());
	} catch (err: any) {
		return filterIgnoredOutput((err.stderr || err.stdout || err.message || "").trim());
	}
}

async function runErrcheck(
	pkgDir: string,
	signal?: AbortSignal,
): Promise<{ output: string; available: boolean }> {
	try {
		const { stdout, stderr } = await exec("errcheck", ["-blank", "-ignoretests", "./..."], {
			cwd: pkgDir,
			timeout: 60_000,
			signal,
		});
		return { output: filterIgnoredOutput((stderr || stdout || "").trim()), available: true };
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return { output: "", available: false };
		}
		return { output: filterIgnoredOutput((err.stderr || err.stdout || err.message || "").trim()), available: true };
	}
}

interface CheckResult {
	findings: string[];
	hasErrcheckIssues: boolean;
}

async function fullCheck(
	pkgDir: string,
	signal?: AbortSignal,
): Promise<CheckResult> {
	const findings: string[] = [];

	const vetOutput = await runGoVet(pkgDir, signal);
	if (vetOutput) {
		findings.push("go vet:\n" + vetOutput);
	}

	const errc = await runErrcheck(pkgDir, signal);
	const hasErrcheckIssues = errc.available && errc.output.length > 0;
	if (hasErrcheckIssues) {
		findings.push("errcheck (unchecked errors):\n" + errc.output);
	}

	return { findings, hasErrcheckIssues };
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const filePath = event.input?.path as string | undefined;
		if (!filePath || !isGoFile(filePath) || isIgnoredGoFile(filePath)) return;

		const absPath = filePath.startsWith("/") ? filePath : ctx.cwd + "/" + filePath;
		const pkgDir = findGoModuleDir(dirname(absPath));
		if (!pkgDir) return;

		const { findings, hasErrcheckIssues } = await fullCheck(pkgDir, ctx.signal);
		if (findings.length === 0) return;

		if (!hasErrcheckIssues) return;

		const relPath = relative(pkgDir, absPath) || filePath;
		const msg =
			"Go error-path check after editing " +
			relPath +
			":\n\n" +
			findings.join("\n\n") +
			"\n\nFix all unchecked error returns before continuing.";

		pi.sendMessage(
			{ customType: "go-errcheck", content: msg, display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
	});

	pi.registerCommand("go-check", {
		description: "Run go vet + errcheck on the current Go module",
		handler: async (args, ctx) => {
			const target = args?.trim()
				? args.trim().startsWith("/")
					? args.trim()
					: ctx.cwd + "/" + args.trim()
				: ctx.cwd;
			const pkgDir = findGoModuleDir(target);
			if (!pkgDir) {
				ctx.ui.notify("Not in a Go module", "error");
				return;
			}
			const { findings } = await fullCheck(pkgDir, ctx.signal);
			if (findings.length === 0) {
				ctx.ui.notify("✅ No issues found", "info");
			} else {
				ctx.ui.notify("⚠️ Issues:\n\n" + findings.join("\n\n"), "error");
			}
		},
	});
}