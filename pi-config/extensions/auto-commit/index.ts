/**
 * Auto-Commit Extension
 *
 * Automatically strips verbose multi-line git commit messages down to just
 * the subject line (first line). No bodies, no bullet points -- just the
 * one-liner.
 *
 * Hooks into `tool_call` for bash commands. When it detects `git commit -m`,
 * it extracts the first line of the message and discards the rest.
 *
 * Example:
 *   Before: git commit -m "feat(search): defer filter loading
 *
 *     Detailed explanation of the change...
 *     - Bullet point 1
 *     - Bullet point 2"
 *
 *   After:  git commit -m "feat(search): defer filter loading"
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Commit message parser
// ---------------------------------------------------------------------------

/**
 * Strip a git commit command's -m message to just the subject line.
 *
 * Uses a single-pass scan of all -m matches with their original positions,
 * then rebuilds the command string. This avoids the re-matching pitfall of
 * iterative regex replacement.
 *
 * Returns null if no change is needed (already a one-liner).
 */
function stripCommitMessage(command: string): string | null {
  if (!/\bgit\s+commit\b/.test(command)) return null;

  // Collect all -m arguments with their absolute positions in one pass
  const mArgs: Array<{ index: number; length: number; quoted: string }> = [];
  const pattern = /-m\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  let m;
  while ((m = pattern.exec(command)) !== null) {
    mArgs.push({ index: m.index, length: m[0].length, quoted: m[1] });
  }

  if (mArgs.length === 0) return null;

  let changed = false;
  const segments: string[] = [];
  let lastEnd = 0;

  for (let i = 0; i < mArgs.length; i++) {
    const arg = mArgs[i];
    // Preserve everything before this -m flag
    segments.push(command.substring(lastEnd, arg.index));

    if (i === 0) {
      // First -m: strip to subject line only
      const content = arg.quoted.slice(1, -1);
      const lines = content.split(/\n/);
      const subject = lines[0].trim();

      if (lines.length > 1 || content !== subject) {
        segments.push(`-m "${subject}"`);
        changed = true;
      } else {
        segments.push(command.substring(arg.index, arg.index + arg.length));
      }
    } else {
      // Subsequent -m flags (body): drop them
      changed = true;
    }

    lastEnd = arg.index + arg.length;
  }

  // Preserve everything after the last -m flag
  segments.push(command.substring(lastEnd));

  if (!changed) return null;

  return segments.join("").replace(/  +/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;

    const input = event.input as { command?: string };
    if (!input?.command) return;

    const stripped = stripCommitMessage(input.command);
    if (stripped) {
      console.log(
        `[auto-commit] Stripped commit body:\n  From: ${input.command}\n  To:   ${stripped}`,
      );
      input.command = stripped;
    }
  });
}
