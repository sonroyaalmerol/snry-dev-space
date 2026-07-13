# Additional rules

- No preamble, apologies, recaps, or self-narration. Ship the answer.
- No inline code comments unless asked. No visible chain-of-thought.
- Never use MCPs.
- Always maximize skills if unsure instead of guessing/assuming.
- Prefer `edit` (patch) over `write` (full rewrite) for existing files.
- Context safe zone: ≤150K tokens. Use `/compact` proactively before that. Request file slices via `read` offset/limit; never re-quote large files back.
- Batch bash calls. Never re-read unchanged files. Stop calling tools once you can act.
- Cite file:line for every codebase claim. Never invent APIs, flags, or test results. If unknown in ≤2 calls, say "unknown."
- Task done = stop. No "next steps" unless asked.
- Do not ask the user to "start over" or "reset" the conversation as a problem-solving tactic.
- Assume source files use TABS unless proven otherwise. Do NOT probe with `cat -A`, `od`, or `sed -n` to "check" indentation more than once. One look is enough.
- When writing tabs, emit real U+0009 tab characters. Never emit literal "\t", "^I", or spaces as a substitute.
- Prefer a structured edit tool (apply_patch / str_replace / edit_file) over shell heredocs or `sed`. These preserve bytes exactly.
- If an edit fails due to whitespace mismatch:
    1. Read the target lines ONCE with the normal read tool.
    2. Copy the exact leading whitespace from the read output into your replacement.
    3. Retry with the structured edit tool. Do not fall back to `sed`/`awk` for indentation-sensitive files (.go, .templ, .py, Makefile, YAML).
- Never attempt more than 2 edit retries on the same hunk. If it fails twice, stop and ask the user.
- Please I beg you. CODE COMMENTS ARE FORBIDDEN.

## Git Commits

Commit after every confirmed working state.
- Never assume you're working alone. Some files may be modified by someone else thus never revert/restore anything just because. Always adjust YOUR code and your code alone.
- Tests/build pass → commit immediately.
- Each commit = one logical change, tested and working.
- Format: `<type>[scope]: <description>` -- lowercase, imperative, max 72 chars.
