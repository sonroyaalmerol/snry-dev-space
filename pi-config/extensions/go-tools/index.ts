/**
 * Go Tools Extension
 *
 * Automatically runs Go development tools after the LLM writes or edits Go
 * files, and provides explicit tools and commands for on-demand use.
 *
 * Auto-hooks (after write/edit on .go files):
 *   1. go fix        -- modernize code (safe, in-place)
 *   2. goimports     -- fix imports (if not already handled by auto-codegen)
 *   3. go vet        -- built-in static analysis diagnostics
 *   4. golangci-lint -- comprehensive linting (falls back to staticcheck)
 *
 * Explicit tools (available to the LLM):
 *   - go_fix         -- run go fix on a path
 *   - go_vet         -- run go vet on a path
 *   - go_lint        -- run golangci-lint (or staticcheck) on a path
 *   - go_test        -- run tests for a package
 *   - go_check       -- run the full quality pipeline (fix + vet + lint + test)
 *
 * Interactive commands:
 *   /go-fix <path>   -- run go fix
 *   /go-vet <path>   -- run go vet
 *   /go-lint <path>  -- run linter
 *   /go-test <path>  -- run tests
 *   /go-check <path> -- full pipeline
 *
 * Only activates in Go projects (requires go.mod in directory tree).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolve, dirname, extname } from "node:path";
import { stat, readFile, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Max time for any single tool run (ms). */
const TOOL_TIMEOUT = 30_000;

/** Max time for the full pipeline (ms). */
const PIPELINE_TIMEOUT = 120_000;

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

/** Walk up from `dir` looking for `filename`. */
async function findUp(
  filename: string,
  dir: string,
  stopAt = "/",
): Promise<string | null> {
  let current = dir;
  while (true) {
    const candidate = resolve(current, filename);
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {}
    const parent = resolve(current, "..");
    if (parent === current || parent === stopAt) return null;
    current = parent;
  }
}

/** Resolve file path to the Go module root (directory containing go.mod). */
async function findModuleRoot(dir: string): Promise<string | null> {
  const modFile = await findUp("go.mod", dir);
  return modFile ? dirname(modFile) : null;
}

/** Run a command and return structured result. */
interface RunResult {
  ok: boolean;
  output: string;
  /** Combined stdout + stderr */
  combined: string;
}

async function runGo(
  pi: ExtensionAPI,
  args: string[],
  opts: { cwd: string; timeout?: number; input?: string },
): Promise<RunResult> {
  const timeout = opts.timeout ?? TOOL_TIMEOUT;
  try {
    const result = await pi.exec("go", args, {
      cwd: opts.cwd,
      timeout,
      input: opts.input,
    });
    const combined = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    return {
      ok: result.code === 0,
      output: result.code === 0 ? combined || "OK" : combined,
      combined,
    };
  } catch (err: any) {
    return { ok: false, output: err.message, combined: err.message };
  }
}

/** Package path relative to module root. e.g. "./cmd/server/..." */
function pkgPath(moduleRoot: string, filePath: string): string {
  const dir = dirname(filePath);
  const rel = dir === moduleRoot ? "." : "." + dir.slice(moduleRoot.length);
  return rel + "/...";
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

interface ToolResult {
  ran: boolean;
  ok: boolean;
  output: string;
  /** Tool name for display */
  tool: string;
}

/** go fix -- modernize Go code (safe, in-place). */
async function goFix(
  pi: ExtensionAPI,
  filePath: string,
  moduleRoot: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  // go fix operates on packages, run on the file's package
  const pkg = pkgPath(moduleRoot, filePath);
  const result = await runGo(pi, ["fix", pkg], { cwd: moduleRoot });

  if (result.ok) {
    const hasChanges = result.combined.length > 0;
    return {
      ran: true,
      ok: true,
      output: hasChanges
        ? `go fix: ${result.combined}`
        : "go fix: no changes needed",
      tool: "go fix",
    };
  }
  return {
    ran: true,
    ok: false,
    output: `go fix failed: ${result.output}`,
    tool: "go fix",
  };
}

/** goimports -- fix imports via stdin/stdout. */
async function goImports(
  pi: ExtensionAPI,
  filePath: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!(await isAvailable("goimports"))) {
    return {
      ran: false,
      ok: true,
      output: "goimports not found, skipping",
      tool: "goimports",
    };
  }

  // Skip templ-generated files
  if (filePath.includes("_templ.go")) {
    return {
      ran: false,
      ok: true,
      output: "skipped (_templ.go)",
      tool: "goimports",
    };
  }

  const content = await readFile(filePath, "utf-8");
  const result = await pi.exec("goimports", [], {
    input: content,
    timeout: 10_000,
    signal,
  });

  if (result.code === 0 && result.stdout) {
    if (result.stdout !== content) {
      await writeFile(filePath, result.stdout, "utf-8");
      return {
        ran: true,
        ok: true,
        output: "goimports: fixed imports",
        tool: "goimports",
      };
    }
    return {
      ran: true,
      ok: true,
      output: "goimports: no changes",
      tool: "goimports",
    };
  }
  return {
    ran: true,
    ok: false,
    output: `goimports failed: ${result.stderr}`,
    tool: "goimports",
  };
}

/** go vet -- built-in static analysis. */
async function goVet(
  pi: ExtensionAPI,
  filePath: string,
  moduleRoot: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const pkg = pkgPath(moduleRoot, filePath);
  const result = await runGo(pi, ["vet", pkg], { cwd: moduleRoot });

  if (result.ok) {
    const hasWarnings = result.combined.length > 0;
    return {
      ran: true,
      ok: true,
      output: hasWarnings ? `go vet: ${result.combined}` : "go vet: clean",
      tool: "go vet",
    };
  }
  // go vet exits non-zero when it finds issues
  return {
    ran: true,
    ok: false,
    output: result.combined || "go vet: issues found",
    tool: "go vet",
  };
}

/**
 * golangci-lint or staticcheck -- comprehensive linting.
 * Prefers golangci-lint (includes staticcheck internally).
 * Falls back to staticcheck if golangci-lint isn't installed.
 */
async function goLint(
  pi: ExtensionAPI,
  filePath: string,
  moduleRoot: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const pkg = pkgPath(moduleRoot, filePath);

  // Prefer golangci-lint
  if (await isAvailable("golangci-lint")) {
    const result = await pi.exec("golangci-lint", ["run", pkg], {
      cwd: moduleRoot,
      timeout: TOOL_TIMEOUT,
      signal,
    });

    const combined = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();

    if (result.code === 0) {
      return {
        ran: true,
        ok: true,
        output: combined
          ? `golangci-lint: ${combined}`
          : "golangci-lint: clean",
        tool: "golangci-lint",
      };
    }
    return {
      ran: true,
      ok: false,
      output: combined || "golangci-lint: issues found",
      tool: "golangci-lint",
    };
  }

  // Fallback to staticcheck
  if (await isAvailable("staticcheck")) {
    const result = await pi.exec("staticcheck", [pkg], {
      cwd: moduleRoot,
      timeout: TOOL_TIMEOUT,
      signal,
    });

    const combined = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();

    if (result.code === 0) {
      return {
        ran: true,
        ok: true,
        output: combined ? `staticcheck: ${combined}` : "staticcheck: clean",
        tool: "staticcheck",
      };
    }
    return {
      ran: true,
      ok: false,
      output: combined || "staticcheck: issues found",
      tool: "staticcheck",
    };
  }

  return {
    ran: false,
    ok: true,
    output: "golangci-lint/staticcheck not found, skipping lint",
    tool: "lint",
  };
}

/** go test -- run tests for the file's package. */
async function goTest(
  pi: ExtensionAPI,
  filePath: string,
  moduleRoot: string,
  signal?: AbortSignal,
  extraArgs?: string[],
): Promise<ToolResult> {
  const dir = dirname(filePath);
  const relDir = dir === moduleRoot ? "." : "." + dir.slice(moduleRoot.length);

  const args = ["test", "-count=1", "-timeout", "30s"];
  if (extraArgs) args.push(...extraArgs);
  args.push(relDir);

  const result = await runGo(pi, args, {
    cwd: moduleRoot,
    timeout: PIPELINE_TIMEOUT,
  });

  if (result.ok) {
    return {
      ran: true,
      ok: true,
      output: result.combined || "go test: passed",
      tool: "go test",
    };
  }
  return {
    ran: true,
    ok: false,
    output: result.combined || "go test: failed",
    tool: "go test",
  };
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

const AUTO_HOOK_STEPS: Array<{
  name: string;
  run: (
    pi: ExtensionAPI,
    filePath: string,
    moduleRoot: string,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  skipIfOk?: boolean; // skip if previous step had issues
}> = [
  { name: "go fix", run: goFix },
  { name: "goimports", run: goImports },
  { name: "go vet", run: goVet },
  { name: "lint", run: goLint },
];

const FULL_PIPELINE_STEPS = [
  ...AUTO_HOOK_STEPS,
  { name: "go test", run: goTest },
];

async function runPipeline(
  pi: ExtensionAPI,
  filePath: string,
  moduleRoot: string,
  steps: typeof AUTO_HOOK_STEPS,
  signal?: AbortSignal,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const step of steps) {
    if (signal?.aborted) break;
    try {
      const result = await step.run(pi, filePath, moduleRoot, signal);
      results.push(result);
    } catch (err: any) {
      results.push({
        ran: false,
        ok: false,
        output: `${step.name} error: ${err.message}`,
        tool: step.name,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatAutoHookResults(results: ToolResult[]): string {
  const parts: string[] = [];

  for (const r of results) {
    if (!r.ran) continue;
    const icon = r.ok ? "✓" : "✗";
    parts.push(`${icon} ${r.output}`);
  }

  return parts.join(" | ");
}

function formatPipelineResults(results: ToolResult[]): string {
  const lines: string[] = [];

  for (const r of results) {
    if (!r.ran) {
      lines.push(`⊘ ${r.tool}: ${r.output}`);
      continue;
    }
    const icon = r.ok ? "✓" : "✗";
    // Multi-line output (e.g. test results) gets its own block
    if (r.output.includes("\n")) {
      lines.push(`${icon} ${r.tool}:`);
      for (const line of r.output.split("\n")) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`${icon} ${r.output}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Track if auto-codegen extension already handles goimports
  // We check by looking at the registered tools
  let autoCodegenHandlesImports = false;

  // -----------------------------------------------------------------------
  // Auto-run Go tools after write/edit on .go files
  // -----------------------------------------------------------------------
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (event.isError) return;

    const input = event.input as { path?: string };
    if (!input?.path) return;

    const filePath = resolve(ctx.cwd, input.path.replace(/^@/, ""));
    const ext = extname(filePath).toLowerCase();
    if (ext !== ".go") return;

    // Skip templ-generated files (handled by auto-codegen's templ generate)
    if (filePath.includes("_templ.go")) return;

    // Only activate in Go modules
    const moduleRoot = await findModuleRoot(dirname(filePath));
    if (!moduleRoot) return;

    // Run the auto-hook pipeline
    let steps = AUTO_HOOK_STEPS;

    // If auto-codegen already ran goimports (detected by checking if its
    // [auto-codegen] tag appears in the result), skip our goimports step
    const hasAutoCodegen = event.content.some(
      (c: any) =>
        typeof c.text === "string" && c.text.includes("[auto-codegen]"),
    );
    if (hasAutoCodegen) {
      steps = steps.filter((s) => s.name !== "goimports");
    }

    const results = await runPipeline(
      pi,
      filePath,
      moduleRoot,
      steps,
      ctx.signal,
    );

    // Build annotation
    const annotation = formatAutoHookResults(results);
    if (!annotation) return;

    const hasIssues = results.some((r) => r.ran && !r.ok);

    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: hasIssues
            ? `[go-tools] ${annotation}`
            : `[go-tools] ${annotation}`,
        },
      ],
    };
  });

  // -----------------------------------------------------------------------
  // go_fix tool
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "go_fix",
    label: "Go Fix",
    description:
      "Run go fix to modernize Go code. Applies safe transformations: " +
      "replaces deprecated APIs, simplifies patterns to use newer stdlib, " +
      "updates code for current Go version idioms. " +
      "Run on a file path (operates on the file's package).",
    promptSnippet: "Modernize Go code with go fix",
    promptGuidelines: [
      "Use go_fix after upgrading Go versions to modernize code.",
      "go fix is safe and should not change behavior.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Go file path (operates on the file's package)",
      }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const moduleRoot = await findModuleRoot(dirname(filePath));
      if (!moduleRoot) throw new Error("Not in a Go module (no go.mod found)");

      const result = await goFix(pi, filePath, moduleRoot, signal);
      if (!result.ok) throw new Error(result.output);
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  // -----------------------------------------------------------------------
  // go_vet tool
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "go_vet",
    label: "Go Vet",
    description:
      "Run go vet for built-in static analysis. Reports likely mistakes: " +
      "unreachable code, wrong printf formats, unused results, lock copies, " +
      "invalid test signatures, and more. Zero config.",
    promptSnippet: "Check Go code with go vet",
    promptGuidelines: [
      "Use go_vet to find likely mistakes that the compiler doesn't catch.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Go file path (operates on the file's package)",
      }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const moduleRoot = await findModuleRoot(dirname(filePath));
      if (!moduleRoot) throw new Error("Not in a Go module (no go.mod found)");

      const result = await goVet(pi, filePath, moduleRoot, signal);
      if (!result.ok) throw new Error(result.output);
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  // -----------------------------------------------------------------------
  // go_lint tool
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "go_lint",
    label: "Go Lint",
    description:
      "Run golangci-lint (or staticcheck as fallback) for comprehensive linting. " +
      "Catches deprecated APIs, unnecessary code, performance issues, correctness bugs, " +
      "missed errors, and more. Prefers golangci-lint if installed.",
    promptSnippet: "Lint Go code with golangci-lint or staticcheck",
    promptGuidelines: [
      "Use go_lint for comprehensive code quality checks beyond go vet.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Go file path (operates on the file's package)",
      }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const moduleRoot = await findModuleRoot(dirname(filePath));
      if (!moduleRoot) throw new Error("Not in a Go module (no go.mod found)");

      const result = await goLint(pi, filePath, moduleRoot, signal);
      if (!result.ok) throw new Error(result.output);
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  // -----------------------------------------------------------------------
  // go_test tool
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "go_test",
    label: "Go Test",
    description:
      "Run go test for the package containing the given file. " +
      "Reports test failures with full output. Supports race detection " +
      "and verbose mode via flags.",
    promptSnippet: "Run Go tests for a package",
    promptGuidelines: [
      "Use go_test to verify changes don't break existing tests.",
      "Run go_test after making changes to verify correctness.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Go file path (tests the file's package)",
      }),
      race: Type.Optional(
        Type.Boolean({ description: "Enable race detector (default: false)" }),
      ),
      verbose: Type.Optional(
        Type.Boolean({ description: "Verbose output (default: false)" }),
      ),
      run: Type.Optional(
        Type.String({ description: "Run only tests matching regex" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const moduleRoot = await findModuleRoot(dirname(filePath));
      if (!moduleRoot) throw new Error("Not in a Go module (no go.mod found)");

      const extraArgs: string[] = [];
      if (params.race) extraArgs.push("-race");
      if (params.verbose) extraArgs.push("-v");
      if (params.run) extraArgs.push("-run", params.run);

      const result = await goTest(pi, filePath, moduleRoot, signal, extraArgs);
      if (!result.ok) throw new Error(result.output);
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  // -----------------------------------------------------------------------
  // go_check tool -- full pipeline
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "go_check",
    label: "Go Check",
    description:
      "Run the full Go quality pipeline: go fix → goimports → go vet → lint → go test. " +
      "Use for a comprehensive check of a package's health after changes.",
    promptSnippet: "Run full Go quality pipeline",
    promptGuidelines: [
      "Use go_check for a comprehensive quality check combining fix, vet, lint, and test.",
      "Prefer go_check over running individual tools when you want a full validation.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Go file path (checks the file's package)",
      }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const moduleRoot = await findModuleRoot(dirname(filePath));
      if (!moduleRoot) throw new Error("Not in a Go module (no go.mod found)");

      const results = await runPipeline(
        pi,
        filePath,
        moduleRoot,
        FULL_PIPELINE_STEPS,
        signal,
      );
      const output = formatPipelineResults(results);

      const hasErrors = results.some((r) => r.ran && !r.ok);
      if (hasErrors) {
        throw new Error(output);
      }
      return { content: [{ type: "text", text: output }] };
    },
  });

  // -----------------------------------------------------------------------
  // Interactive commands
  // -----------------------------------------------------------------------
  pi.registerCommand("go-fix", {
    description: "Run go fix on a path (usage: /go-fix <path>)",
    handler: async (args, ctx) => {
      const path = args?.trim();
      if (!path) {
        ctx.ui.notify("Usage: /go-fix <path>", "warning");
        return;
      }

      const filePath = resolve(ctx.cwd, path.replace(/^@/, ""));
      const moduleRoot = await findModuleRoot(dirname(filePath));
      if (!moduleRoot) {
        ctx.ui.notify("Not in a Go module", "error");
        return;
      }

      ctx.ui.setStatus("go-tools", `Running go fix on ${path}...`);
      const result = await goFix(pi, filePath, moduleRoot);
      ctx.ui.setStatus("go-tools", undefined);

      ctx.ui.notify(
        result.ok ? `✓ ${result.output}` : `✗ ${result.output}`,
        result.ok ? "info" : "error",
      );
    },
  });

  pi.registerCommand("go-vet", {
    description: "Run go vet on a path (usage: /go-vet <path>)",
    handler: async (args, ctx) => {
      const path = args?.trim();
      if (!path) {
        ctx.ui.notify("Usage: /go-vet <path>", "warning");
        return;
      }

      const filePath = resolve(ctx.cwd, path.replace(/^@/, ""));
      const moduleRoot = await findModuleRoot(dirname(filePath));
      if (!moduleRoot) {
        ctx.ui.notify("Not in a Go module", "error");
        return;
      }

      ctx.ui.setStatus("go-tools", `Running go vet on ${path}...`);
      const result = await goVet(pi, filePath, moduleRoot);
      ctx.ui.setStatus("go-tools", undefined);

      ctx.ui.notify(
        result.ok ? `✓ ${result.output}` : `✗ ${result.output}`,
        result.ok ? "info" : "error",
      );
    },
  });

  pi.registerCommand("go-lint", {
    description:
      "Run golangci-lint or staticcheck on a path (usage: /go-lint <path>)",
    handler: async (args, ctx) => {
      const path = args?.trim();
      if (!path) {
        ctx.ui.notify("Usage: /go-lint <path>", "warning");
        return;
      }

      const filePath = resolve(ctx.cwd, path.replace(/^@/, ""));
      const moduleRoot = await findModuleRoot(dirname(filePath));
      if (!moduleRoot) {
        ctx.ui.notify("Not in a Go module", "error");
        return;
      }

      ctx.ui.setStatus("go-tools", `Running lint on ${path}...`);
      const result = await goLint(pi, filePath, moduleRoot);
      ctx.ui.setStatus("go-tools", undefined);

      ctx.ui.notify(
        result.ok ? `✓ ${result.output}` : `✗ ${result.output}`,
        result.ok ? "info" : "error",
      );
    },
  });

  pi.registerCommand("go-test", {
    description: "Run go test for a package (usage: /go-test <path>)",
    handler: async (args, ctx) => {
      const path = args?.trim();
      if (!path) {
        ctx.ui.notify("Usage: /go-test <path>", "warning");
        return;
      }

      const filePath = resolve(ctx.cwd, path.replace(/^@/, ""));
      const moduleRoot = await findModuleRoot(dirname(filePath));
      if (!moduleRoot) {
        ctx.ui.notify("Not in a Go module", "error");
        return;
      }

      ctx.ui.setStatus("go-tools", `Running go test on ${path}...`);
      const result = await goTest(pi, filePath, moduleRoot);
      ctx.ui.setStatus("go-tools", undefined);

      ctx.ui.notify(
        result.ok ? `✓ ${result.output}` : `✗ ${result.output}`,
        result.ok ? "info" : "error",
      );
    },
  });

  pi.registerCommand("go-check", {
    description: "Run full Go quality pipeline (usage: /go-check <path>)",
    handler: async (args, ctx) => {
      const path = args?.trim();
      if (!path) {
        ctx.ui.notify("Usage: /go-check <path>", "warning");
        return;
      }

      const filePath = resolve(ctx.cwd, path.replace(/^@/, ""));
      const moduleRoot = await findModuleRoot(dirname(filePath));
      if (!moduleRoot) {
        ctx.ui.notify("Not in a Go module", "error");
        return;
      }

      ctx.ui.setStatus("go-tools", `Running full pipeline on ${path}...`);
      const results = await runPipeline(
        pi,
        filePath,
        moduleRoot,
        FULL_PIPELINE_STEPS,
      );
      ctx.ui.setStatus("go-tools", undefined);

      const output = formatPipelineResults(results);
      const hasErrors = results.some((r) => r.ran && !r.ok);

      if (hasErrors) {
        // Show multi-line output via notify with lines
        for (const line of output.split("\n")) {
          console.log(`[go-tools] ${line}`);
        }
        ctx.ui.notify("Issues found -- see console", "warning");
      } else {
        ctx.ui.notify("All checks passed ✓", "info");
      }
    },
  });
}
