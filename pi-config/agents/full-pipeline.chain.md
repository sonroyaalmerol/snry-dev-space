---
name: full-pipeline
description: Full parallel-scout → plan → implement → review pipeline
---

## scout
output: structure.md

Quickly map the codebase structure relevant to {task}. Do NOT read files deeply -- just identify:
1. What areas/domains of the codebase are involved
2. Which directories and key files belong to each area
3. How many parallel scouts are needed (2-5 depending on scope)

Keep it under 40 lines. You are a splitter, not a deep reader.

## parallel
concurrency: 4
worktree: true

### scout-fast[output=area-1.md]
Scout the FIRST area identified in {previous}. Read only files in that area. Report key types, functions, data flow, and what likely needs changing.

### scout-fast[output=area-2.md]
Scout the SECOND area identified in {previous}. Read only files in that area. Report key types, functions, data flow, and what likely needs changing.

### scout-fast[output=area-3.md, model=ollama/gemma4:31b]
Scout the THIRD area identified in {previous}. Read only files in that area. Report key types, functions, data flow, and what likely needs changing.

### scout-fast[output=area-4.md, model=zai-glm/glm-4.7-flash]
Scout the FOURTH area identified in {previous} (if applicable -- if only 3 areas were identified, report "no fourth area needed"). Read only files in that area. Report key types, functions, data flow, and what likely needs changing.

## planner
reads: structure.md,area-1.md,area-2.md,area-3.md,area-4.md
model: google-gemini-cli/gemini-3-flash-preview
thinking: high
output: plan.md

Synthesize all scouting results from {previous} into a comprehensive implementation plan.

## worker-gemini
reads: plan.md
progress: true

Implement the plan from {previous}

## reviewer
reads: plan.md
model: google-gemini-cli/gemini-3.1-pro-preview
thinking: high

Review the changes against {previous}
