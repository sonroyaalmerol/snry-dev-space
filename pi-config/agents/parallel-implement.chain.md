---
name: parallel-implement
description: Parallel implementation across 3 models with load balancing
---

## scout
output: context.md

Analyze the codebase for {task}

## planner
reads: context.md
model: google-gemini-cli/gemini-3-flash-preview
thinking: high
output: plan.md

Create an implementation plan based on {previous}

## parallel
concurrency: 3
worktree: true

### worker-gemini
reads: plan.md
progress: true

Implement the primary features from the plan

### worker-glm47
reads: plan.md
progress: true

Implement the secondary features from the plan

### worker-flash
reads: plan.md
progress: true

Implement the supporting changes from the plan

## reviewer
model: google-gemini-cli/gemini-3.1-pro-preview
thinking: high
reads: plan.md

Review all changes from {previous}
