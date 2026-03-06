---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior — before proposing fixes.
---

# Systematic Debugging

**Hard gate: Do NOT propose a fix until you have identified the root cause with evidence.** No guessing. No "let's try this and see." If you can't explain *why* it's broken, you're not ready to fix it.

## Phases

### 1. Investigate

Gather the facts before forming opinions.

- What is happening vs. what is expected?
- Read the relevant code, logs, and error messages.
- Reproduce the issue if possible.

Share what you find as you go — brief updates so the user can follow along.

### 2. Compare Patterns

Find working examples of similar code in the codebase. Compare them with the broken case. Identify what's different — the root cause usually lives in the delta.

### 3. Hypothesize and Test

Form a specific, testable hypothesis about the root cause. Not "something might be wrong with X" — state the exact mechanism: "function Y returns null when Z is empty because the guard clause on line N exits early."

Verify the hypothesis with a minimal targeted change (add logging, check a condition, isolate a variable). Confirm the evidence supports it before moving on.

### 4. Implement

Once the root cause is confirmed:

1. **Present the fix to the user.** Explain what's broken, why, and what you'll change. Keep it concise.
2. **Wait for approval.** Do not implement without it.
3. **Follow `tdd` discipline.** Write a test that reproduces the bug first, then fix it.

## Rules

- **Report as you go.** Each phase should produce at least one chat update. The user is likely on their phone — keep updates short and scannable.
- **No shotgun debugging.** One hypothesis at a time. Verify before moving to the next.
- **Architectural checkpoint:** If three fix attempts fail, stop. Something foundational may be wrong. Reassess the approach entirely and discuss with the user before continuing.
