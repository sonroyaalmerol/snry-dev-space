---
name: scout-plan
description: Gather context then plan implementation
---

## scout
output: context.md

Analyze the codebase for {task}

## planner
reads: context.md
model: google-gemini-cli/gemini-3-flash-preview
thinking: high
progress: true

Create an implementation plan based on {previous}
