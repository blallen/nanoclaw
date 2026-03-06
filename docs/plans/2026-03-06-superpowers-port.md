# Superpowers Port Implementation Plan

> **For Claude:** Execute tasks sequentially. Each task is one file. Commit after each.

**Goal:** Add 5 workflow discipline skills to NanoClaw's container agent, adapted from superpowers for chat-based interaction.

**Architecture:** Markdown skill files in `container/skills/{name}/SKILL.md`, synced to containers by existing `container-runner.ts` logic. One CLAUDE.md edit to add the governance pointer.

**Constraints:** Each skill under 500 words. Self-contained. Chat-optimized (batch questions, condensed output). Clear hard gates.

---

### Task 1: workflow-governance skill

**Files:**
- Create: `container/skills/workflow-governance/SKILL.md`

Routes the agent to the right workflow. Under 200 words.
- build/add/create → brainstorming
- fix/debug/broken → systematic-debugging
- code changes → TDD
- simple questions → no workflow
- User can force a workflow explicitly

### Task 2: brainstorming skill

**Files:**
- Create: `container/skills/brainstorming/SKILL.md`

Adapted from superpowers brainstorming. Under 500 words.
- Hard gate: no implementation until design approved
- Process: context → batched questions → approaches → design → approval → save artifact
- Batch 2-3 questions per message (phone-friendly)
- Transition to design-before-code

### Task 3: design-before-code skill

**Files:**
- Create: `container/skills/design-before-code/SKILL.md`

Combines writing-plans + executing-plans. Under 500 words.
- Hard gate: no code until plan approved
- Process: read design → break into steps → present plan → approve → execute → status updates
- Code steps follow TDD

### Task 4: tdd skill

**Files:**
- Create: `container/skills/tdd/SKILL.md`

Adapted from superpowers TDD. Under 500 words.
- Hard gate: no production code without preceding failing test
- Red-green-refactor cycle
- Skip for non-code tasks

### Task 5: systematic-debugging skill

**Files:**
- Create: `container/skills/systematic-debugging/SKILL.md`

Adapted from superpowers debugging. Under 500 words.
- Hard gate: no fix until root cause identified with evidence
- Four phases: investigate → compare → hypothesize → implement
- 3-failure checkpoint

### Task 6: CLAUDE.md governance pointer

**Files:**
- Modify: `groups/main/CLAUDE.md`

Add 2-3 lines near top pointing to workflow-governance skill.

### Task 7: Verify skill sync works

Confirm `container-runner.ts` sync logic picks up all new directories.
