---
name: tdd
description: Use when implementing any feature or bugfix — before writing production code. Enforces the red-green-refactor cycle.
---

# TDD

**Hard gate: Do NOT write production code without a preceding failing test.** No exceptions. If you didn't watch the test fail, you don't know if it tests the right thing. A test you never saw fail could be passing for the wrong reason — a typo, a tautology, a no-op assertion. The red step is what proves the test is real.

## The Cycle

For each new behavior or fix, repeat this loop:

### 1. Write a Failing Test (Red)

Write one test that describes the next piece of desired behavior. Keep it focused — one assertion per behavior.

### 2. Run the Test — Confirm It FAILS

```bash
# Run the test suite (adapt command to the project's test runner)
```

You **must** see the failure output. Read it. Confirm the test fails for the reason you expect — not a syntax error, not an import error, but the actual missing behavior. If it passes, the test is wrong — fix it before continuing.

### 3. Write the Minimum Code to Pass (Green)

Write the **smallest** change that makes the failing test pass. Nothing more. No "while I'm here" additions, no anticipated future needs, no extra branches. If the test doesn't require it, don't write it.

### 4. Run the Test — Confirm It PASSES

```bash
# Run the test suite again
```

All tests must pass — not just the new one. If anything breaks, fix it before moving on.

### 5. Refactor (Optional)

Clean up duplication or improve clarity, then re-run tests to confirm nothing broke.

### 6. Repeat

Go back to step 1 for the next behavior.

## Rules

- **One behavior per cycle.** Don't write three tests then implement all at once.
- **Never skip the red step.** Running the test and watching it fail is mandatory every single time.
- **Minimal implementation.** The code should do exactly what the tests demand — nothing more.
- **All tests pass before moving on.** A green suite is your checkpoint between cycles.

## When to Skip TDD

- Documents, configs, markdown files, and non-code assets don't need tests.
- Wiring-only changes (imports, re-exports, dependency injection) that are trivially verified by an existing test suite.

When skipping, state why briefly and move on.
