---
name: brainstorming
description: Use before any creative or constructive work — building features, adding functionality, modifying behavior. Gates implementation behind design approval.
---

# Brainstorming

**Hard gate: Do NOT write code, create scaffolding, or take any build action until the user explicitly approves the design.** No exceptions. Not even "just getting started" or "laying groundwork."

## Process

### 1. Gather Context

Read relevant files silently — CLAUDE.md, related source files, recent conversation. Understand what exists before proposing anything.

### 2. Ask Clarifying Questions

Send one message with 2-3 batched questions. Offer choices where possible instead of open-ended questions.

Example:
> A few questions before I design this:
> - Should X integrate with Y, or stay standalone?
> - Performance or simplicity — which matters more here?
> - Any existing patterns I should match?

Do not ask questions one at a time. Phone screens are small — respect them.

### 3. Propose Approaches

Present 2-3 options with trade-offs. State your recommendation and why.

Keep each option to 2-3 sentences. Use a short label for each (e.g., "Option A: Lightweight adapter"). The user should be able to skim and pick without scrolling extensively.

### 4. Present Design for Approval

Once direction is clear, write up the design in chat:
- What it does
- How it works (high-level)
- What it changes or touches
- Open questions or risks

Ask explicitly: "Does this design look good, or should I adjust anything?"

**Wait for approval. Do not proceed without it.**

### 5. Save the Design

On approval, save as a markdown file:
- Group folder work: `/workspace/group/plans/YYYY-MM-DD-<topic>-design.md`
- Mounted codebase work: `docs/plans/YYYY-MM-DD-<topic>-design.md` in the project repo

### 6. Hand Off to Implementation

Invoke the `design-before-code` skill to plan implementation steps from the approved design.
