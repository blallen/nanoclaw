---
name: design-before-code
description: Use after brainstorming produces an approved design — breaks it into an implementation plan, gets approval, then executes steps sequentially.
---

# Design Before Code

**Hard gate: Do NOT write any code until the user explicitly approves the implementation plan.** No exceptions. Not "just scaffolding," not "just the types." Plan first, approve, then build.

## Process

### 1. Read the Approved Design

Open the design document saved by the `brainstorming` skill. Read all related source files silently to understand the current state.

### 2. Break Into Implementation Steps

Create an ordered list of small steps. Each step must have:

- **What:** one clear action (create a file, modify a function, add a config entry)
- **Inputs:** what it reads or depends on
- **Output:** what it produces or changes
- **Verify:** how to confirm it worked (test passes, command output, file exists)

Steps should be small enough that a single status update covers what happened. Order them so each step builds on the last — earlier steps should not depend on later ones.

### 3. Present the Plan for Approval

Send the numbered step list in chat. Keep each step to 1-2 lines. At the end, ask: "Does this plan look right, or should I adjust anything?"

**Wait for approval. Do not proceed without it.**

### 4. Save the Plan

On approval, save as a markdown file:

- Group folder work: `/workspace/group/plans/YYYY-MM-DD-<topic>-plan.md`
- Mounted codebase work: `docs/plans/YYYY-MM-DD-<topic>-plan.md` in the project repo

### 5. Execute Steps Sequentially

Work through the plan one step at a time:

1. Start the step
2. When the step involves writing code, follow the `tdd` skill discipline
3. Verify the step using the criteria from the plan
4. Send a brief status update: what was done, what's next

Do not skip ahead. Do not batch multiple steps silently. The user should always know where you are in the plan.

### 6. Handle Problems

If a step fails or the plan needs to change:

- Stop and tell the user what went wrong
- Propose the adjustment
- Wait for approval before continuing

Never silently rework the plan. The user approved a specific sequence — changes need their sign-off.
