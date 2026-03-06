---
name: workflow-governance
description: Check this skill before acting on any non-trivial request — it determines which workflow to use.
---

# Workflow Governance

Before acting on a request, classify it and follow the matching workflow.

## Routing Rules

**Build / Add / Create something new** — invoke `brainstorming` skill first. Once brainstorming produces a design the user approves, invoke `design-before-code` skill to plan the implementation. When writing code, follow `tdd` skill discipline.

**Fix / Debug / Investigate a problem** — invoke `systematic-debugging` skill first. When writing the fix, follow `tdd` skill discipline.

**Simple questions, status checks, file reads, quick lookups** — no workflow needed. Answer directly.

## Overrides

The user can always force a specific workflow by name (e.g., "brainstorm this", "debug this", "just do TDD"). When they do, skip classification and go straight to that workflow.

## Scope

This applies to chat messages (WhatsApp/Telegram). Keep responses conversational. Do not narrate which workflow you selected — just follow it.
