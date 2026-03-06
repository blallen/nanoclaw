# Porting Superpowers Workflow Disciplines to NanoClaw

**Date:** 2026-02-24
**Status:** Approved

## Problem

When the NanoClaw bot is asked to do complex work — design a feature, debug something, write code — it jumps straight to implementation. There's no structured brainstorming, no design approval gate, no TDD discipline, no systematic debugging process. The [superpowers](https://github.com/obra/superpowers) plugin solves this for Claude Code, but those skills are designed for a CLI tool with interactive skill loading, git worktrees, and desktop-oriented workflows. They need to be adapted for a chat-based bot running inside containers.

## Goals

- The bot should automatically engage structured workflows when the task warrants it (brainstorm before building, design before coding, TDD when writing code, root-cause analysis before fixing bugs)
- The user can also explicitly request a workflow ("brainstorm about X", "debug Y")
- Plan/design artifacts are persisted as files (in the group folder for non-code work, in the project repo for codebase work)
- Skills are modular — each workflow is its own file, easy to add/remove/edit
- No infrastructure changes needed beyond writing the skill files

## Non-Goals

- Dynamic skill loading via MCP (overkill for now)
- Porting every superpowers skill — only the four core disciplines
- Git worktree management (the bot doesn't need isolated workspaces)
- Code review subagent dispatch (no multi-agent orchestration yet)
- Parallel agent execution (single container per group constraint)

## Existing Infrastructure

The skill loading pipeline already exists:

1. **Host:** `container/skills/` contains skill directories, each with a `SKILL.md`
2. **container-runner.ts:167-182:** On every container spawn, copies all skill directories from `container/skills/` into the group's `.claude/skills/` directory
3. **Agent SDK:** The `Skill` tool is in the `allowedTools` list, so the agent can invoke skills by name
4. **Inside container:** Skills appear at `/home/node/.claude/skills/{name}/SKILL.md` and are discoverable by the SDK

Currently only `agent-browser` exists as a skill. We add new skill directories alongside it.

## Architecture

```
container/skills/
├── agent-browser/SKILL.md          (existing — browser automation)
├── workflow-governance/SKILL.md    (new — meta-skill: when to use which workflow)
├── brainstorming/SKILL.md          (new — explore → propose → approve)
├── design-before-code/SKILL.md     (new — write plan → get approval → implement)
├── tdd/SKILL.md                    (new — red-green-refactor cycle)
└── systematic-debugging/SKILL.md   (new — investigate → hypothesize → fix)
```

The container-runner's existing sync logic copies these into every group's `.claude/skills/` automatically. No code changes needed.

## Skill Descriptions

### 1. workflow-governance

**Purpose:** The meta-skill that teaches the agent when to engage each workflow. Analogous to superpowers' `using-superpowers` but adapted for chat context.

**Trigger:** Loaded into the agent's awareness via the skill index (the SDK automatically lists available skills). The agent checks this when processing any non-trivial request.

**Key adaptations from superpowers:**
- No `Skill` tool invocation ceremony — the agent reads the governance skill once and internalizes the routing logic
- Hybrid trigger model: auto-engage for "build X", "add Y", "create Z" patterns; also respond to explicit "brainstorm", "debug", "plan" commands
- Simpler than superpowers' version — no skill priority matrix, no rationalization checklist, just clear routing rules

**Content outline:**
```
When to use each workflow:
- User asks to build/add/create something → brainstorming first
- User asks to fix/debug/investigate something → systematic-debugging first
- After brainstorming produces an approved design → design-before-code
- Writing any code → follow TDD discipline
- Simple questions, status checks, file reads → no workflow needed
```

### 2. brainstorming

**Purpose:** Before implementing anything, explore the idea through conversation. Understand context, ask clarifying questions, propose approaches, get explicit approval.

**Trigger:** Auto-engaged when the user asks to build, add, or create something. Also triggered by explicit "brainstorm about X" or "let's think about X".

**Key adaptations from superpowers:**
- Questions come as chat messages, not CLI prompts — keep them concise, one at a time
- No TodoWrite tracking (overkill for chat) — just follow the sequence naturally
- Design presented in chat, then saved to a file on approval
- Artifact storage: `/workspace/group/plans/` for non-code work, `docs/plans/` in the project repo when working on a codebase

**Process:**
1. Read relevant context (CLAUDE.md, existing files, recent conversation)
2. Ask clarifying questions one at a time (prefer offering choices)
3. Propose 2-3 approaches with trade-offs and a recommendation
4. Present the design in chat for approval
5. On approval, save to a plan file
6. Transition to design-before-code for implementation planning

**Hard gate:** No implementation until the user approves the design.

### 3. design-before-code

**Purpose:** After brainstorming produces an approved design, break it into concrete implementation steps before writing any code.

**Trigger:** Follows brainstorming approval. Also triggered by explicit "plan the implementation of X" when a design already exists.

**Key adaptations from superpowers:**
- Combined equivalent of superpowers' `writing-plans` + `executing-plans`
- No git worktree setup (container already provides isolation)
- No subagent dispatch — the single container agent executes steps sequentially
- Steps should be small and verifiable — each one ends with a check the user can see
- Plan saved alongside the design document

**Process:**
1. Read the approved design
2. Break into ordered implementation steps (each with clear inputs, outputs, verification)
3. Present the plan in chat for approval
4. On approval, execute steps one at a time
5. After each step, briefly report what was done and what's next
6. When writing code, follow TDD discipline (invoke that skill)

**Hard gate:** No code until the user approves the implementation plan.

### 4. tdd (test-driven development)

**Purpose:** When writing code, follow the red-green-refactor cycle. Write a failing test first, then make it pass, then refactor.

**Trigger:** Engaged whenever the agent is about to write implementation code (during design-before-code execution, or when asked to add a feature/fix a bug in code).

**Key adaptations from superpowers:**
- Same core discipline — this one translates directly
- Adapted for the container environment: tests run via Bash inside the container
- No pre-commit hooks or git integration — just the testing cycle
- For non-code tasks (writing documents, configs), this skill doesn't apply — skip it

**Process:**
1. Write a failing test that describes the desired behavior
2. Run the test, confirm it fails (red)
3. Write the minimum code to make it pass
4. Run the test, confirm it passes (green)
5. Refactor if needed, re-run tests to confirm nothing broke
6. Repeat for next behavior

**Hard gate:** No production code without a preceding failing test.

### 5. systematic-debugging

**Purpose:** When something is broken, investigate the root cause before proposing fixes. No guessing.

**Trigger:** Auto-engaged when the user reports a bug, error, or unexpected behavior. Also triggered by explicit "debug X" or "investigate why X".

**Key adaptations from superpowers:**
- Same core discipline — investigate before fixing
- Chat-friendly: report findings as you go so the user can follow along
- Container constraints: debugging tools available are Bash, file reads, web search — no interactive debuggers
- Report root cause and proposed fix before implementing

**Process:**
1. Gather symptoms — what's happening vs. what's expected
2. Read relevant code, logs, error messages
3. Form hypotheses about the root cause
4. Test hypotheses (add logging, check conditions, reproduce)
5. Identify the root cause with evidence
6. Propose a fix and get approval before implementing
7. Implement the fix following TDD (write a test that reproduces the bug first)

**Hard gate:** No fix proposed until root cause is identified with evidence.

## Workflow Chains

The skills chain together in predictable sequences:

```
User: "Build X"
  → workflow-governance routes to brainstorming
    → brainstorming: explore, propose, get design approval
      → design-before-code: break into steps, get plan approval
        → tdd: red-green-refactor for each code step
          → done: report completion with evidence

User: "Fix Y" / "Y is broken"
  → workflow-governance routes to systematic-debugging
    → systematic-debugging: investigate, identify root cause
      → tdd: write reproducing test, then fix
        → done: report fix with evidence

User: "What's the status of Z?" / "Read file X"
  → workflow-governance: no workflow needed, just answer
```

## Artifact Storage

Plans and designs are persisted as markdown files:

| Context | Storage location | Example |
|---------|-----------------|---------|
| Non-code work (group folder) | `/workspace/group/plans/` | `plans/2026-02-24-notification-system-design.md` |
| Codebase work (project mount) | `docs/plans/` in the project repo | `docs/plans/2026-02-24-auth-refactor-design.md` |

The agent determines which to use based on whether it's working in `/workspace/group/` or `/workspace/project/`.

## What We're NOT Porting

These superpowers skills are excluded and why:

| Skill | Why excluded |
|-------|-------------|
| `using-git-worktrees` | Container already provides isolation. No git worktrees needed. |
| `subagent-driven-development` | NanoClaw runs one container per group. No concurrent subagents. |
| `dispatching-parallel-agents` | Same constraint — single container. |
| `executing-plans` | Merged into `design-before-code` since there's no separate session model. |
| `requesting-code-review` / `receiving-code-review` | No multi-agent review loop. The user reviews in chat. |
| `finishing-a-development-branch` | Git branch management is out of scope for the bot. |
| `writing-skills` | Meta-skill for creating new superpowers skills. Not needed inside the bot. |
| `verification-before-completion` | Folded into TDD — verification is part of the red-green cycle. |

## Implementation Scope

The entire implementation is writing 5 markdown files in `container/skills/`. No TypeScript changes. No container rebuild. No config changes. The existing `container-runner.ts` sync logic handles everything.

Each skill file should be:
- Under 500 words (token-efficient for the agent's context)
- Self-contained (no cross-file references)
- Written for a chat context (not CLI)
- Clear about hard gates (what the agent must NOT do until a condition is met)

## Testing

After writing the skills:
1. Send a message like "Build a simple task tracker" → verify brainstorming engages
2. Approve a design → verify design-before-code engages
3. Send "This is broken: [error]" → verify systematic-debugging engages
4. Check that simple questions ("What time is it?") don't trigger workflows
5. Verify plan files are created in the correct locations

## Design Decisions

1. **Workflow-governance: skill with CLAUDE.md pointer.** The full governance logic lives in the skill file. CLAUDE.md gets a brief reference (1-2 lines) pointing the agent to the skill so it knows to check it. This keeps the always-in-context cost minimal while ensuring discoverability.

2. **Batch questions for mobile-friendly chat.** Batch 2-3 related questions per message instead of one-at-a-time. Keep output condensed for phone screens — avoid walls of text. The exact presentation format will be iterated on during implementation.

3. **Artifacts only for non-trivial work, with manual override.** The agent uses judgment to skip the full workflow for simple tasks. The user can always force a workflow explicitly ("brainstorm this", "write a plan for X") to override that judgment.
