# Telegram Stale-Session Crash-Loop Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When the host `claude` CLI rejects a stored session id with "No conversation found with session ID", `runHostClaudeAgent` transparently retries the same prompt once with a fresh session instead of letting the orchestrator enter an infinite exponential-backoff retry loop.

**Architecture:** The fix lives entirely in `src/host-claude-runner.ts`. Today `runHostClaudeAgent` is one large `new Promise` with `spawn()` inline, so it can only ever spawn once. We extract the spawn-and-collect body into an inner `attempt(sessionId, attemptNo)` function that resolves a richer `AttemptResult` (the `ContainerOutput` plus `stdout`/`stderr`/`hadStreamingOutput`). The outer function calls `attempt()` once, and — only if that attempt failed, a `sessionId` was supplied, nothing was streamed to the user yet, and the output text matches the stale-session signature — calls `attempt(undefined, 2)`. The fresh spawn produces a new `session_id` via the existing `ClaudeStreamParser`, which flows out as `newSessionId` and is persisted by the existing code in `src/index.ts:292-294`. No orchestrator, DB, or container-runner changes.

**Tech Stack:** TypeScript (ESM, NodeNext), Node `child_process.spawn`, vitest (`npx vitest run`), jj (Jujutsu) for version control.

---

## Background (read this first)

The design/spec for this work is `docs/plans/2026-07-26-telegram-stale-session-crashloop-fix.md`. Read it before starting. Summary of the bug:

- The `main` group runs the host `claude` CLI (`src/host-claude-runner.ts`), not the Apple Container.
- Each turn passes `--resume <sessionId>` when a stored id exists (`buildClaudeArgs`, `src/host-claude-runner.ts:53-75`).
- If that id is not in the host session store (`data/sessions/main/.claude`), `claude` exits **1** with `No conversation found with session ID: <uuid>` on stderr.
- `runAgent` in `src/index.ts` treats that as an agent error, rolls back the message cursor, and retries with backoff — re-reading the **same** stale id from the in-memory `sessions` map. Every retry fails identically. The user never gets a reply.

### Things the spec does not call out that this plan handles

1. **Do not retry if output was already streamed.** `onOutput` sends text to Telegram incrementally. A blind retry after partial output would double-post. The stale-session failure happens before any stdout, so gating on `hadStreamingOutput === false` costs nothing and prevents a nasty class of duplicate-message bugs.
2. **Move IPC image cleanup out of the per-attempt path.** The `close` handler currently deletes everything in `<IPC_DIR>/images`. If attempt 1 wiped the images the prompt refers to, attempt 2 would run against missing files. Cleanup moves to the outer function, after the final attempt.
3. **Match against stdout as well as stderr.** The spec observed the message on stderr, but under `--output-format stream-json` an error can also surface in a `result` event on stdout. Checking both is cheap and more robust.
4. **Distinct process names per attempt.** `onProcess(child, name)` registers the process with the group queue. Attempt 2 gets a `-retry2` suffix so the two registrations can't collide.

### Version control note

This repo uses **jj (Jujutsu)**, not git directly. Commit with:

```bash
jj describe -m "message"
jj new
```

Do **not** squash commits — the user prefers a commit per task.

---

## Task 1: Add the `isStaleSessionError` predicate

A pure, exported helper so detection is unit-testable without any spawn mocking.

**Files:**
- Modify: `src/host-claude-runner.ts` (add export near `buildClaudeArgs`, around line 75)
- Test: `src/host-claude-runner.test.ts` (append a new `describe` block)

**Step 1: Write the failing test**

Append to `src/host-claude-runner.test.ts`, and add `isStaleSessionError` to the existing import on line 3:

```ts
describe('isStaleSessionError', () => {
  it('matches the claude CLI stale-session message', () => {
    expect(
      isStaleSessionError(
        'No conversation found with session ID: 0b1f4a2e-1c33-4d9a-9f2e-77aa1b2c3d4e',
      ),
    ).toBe(true);
  });

  it('matches case-insensitively and when embedded in surrounding log noise', () => {
    expect(
      isStaleSessionError(
        '[DEBUG] starting\nno conversation found with session id: abc\n[DEBUG] exiting\n',
      ),
    ).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isStaleSessionError('')).toBe(false);
    expect(isStaleSessionError('Error: connection reset by peer')).toBe(false);
    expect(isStaleSessionError('Invalid API key')).toBe(false);
    // A session id appearing in ordinary output must not trip the check.
    expect(isStaleSessionError('resuming session ID: abc')).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/host-claude-runner.test.ts
```

Expected: FAIL — `isStaleSessionError is not a function` (or a TS/import error).

**Step 3: Write minimal implementation**

Add to `src/host-claude-runner.ts` immediately after `buildClaudeArgs` (after line 75):

```ts
/**
 * True when claude's output indicates the id passed to `--resume` is not in the
 * host session store. Observed on stderr with exit code 1:
 *
 *   No conversation found with session ID: <uuid>
 *
 * Checked against stdout too — under --output-format stream-json the same
 * failure can surface in a `result` event rather than on stderr.
 */
export function isStaleSessionError(text: string): boolean {
  return /No conversation found with session ID/i.test(text);
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/host-claude-runner.test.ts
```

Expected: PASS (all `buildClaudeArgs` tests plus the 3 new ones).

**Step 5: Commit**

```bash
jj describe -m "feat: isStaleSessionError predicate for host claude --resume failures"
jj new
```

---

## Task 2: Build the spawn-mock test harness (characterization test)

Before refactoring `runHostClaudeAgent`, lock in its current happy-path behavior so the refactor in Task 3 is provably behavior-preserving. `runHostClaudeAgent` has **no** tests today — only the pure `buildClaudeArgs` does.

**Files:**
- Create: `src/host-claude-runner-run.test.ts`

Use a **separate file** from `host-claude-runner.test.ts`. That file has no module mocks; adding `vi.mock('fs')` and `vi.mock('child_process')` to it would apply to every test in the file. A separate file keeps the pure-function tests running against real modules.

**Step 1: Write the test**

Create `src/host-claude-runner-run.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// --- Module mocks (hoisted above the imports by vitest) ---

vi.mock('./config.js', () => ({
  CONTAINER_MAX_OUTPUT_SIZE: 10_485_760,
  CONTAINER_TIMEOUT: 1_800_000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1_800_000,
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ CLAUDE_CODE_OAUTH_TOKEN: 'test-token' })),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const stub = {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => [] as string[]),
    unlinkSync: vi.fn(),
  };
  return { ...stub, default: stub };
});

// Fake child process. `spawnCalls` is populated at spawn() call time (test
// runtime), not when the mock factory runs, so referencing it here is safe.
type FakeProc = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  args: string[];
};

const spawnCalls: FakeProc[] = [];

function createFakeProcess(args: string[]): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 4242;
  proc.args = args;
  return proc;
}

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((_bin: string, args: string[]) => {
      const proc = createFakeProcess(args);
      spawnCalls.push(proc);
      return proc;
    }),
  };
});

import { runHostClaudeAgent } from './host-claude-runner.js';
import type { RegisteredGroup } from './types.js';

const group: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Taskie',
  added_at: new Date().toISOString(),
};

const input = {
  prompt: 'hello',
  groupFolder: 'main',
  chatJid: 'main@g.us',
  isMain: true,
};

/** Emit a normal init + assistant text + success result stream, then exit 0. */
function emitSuccess(proc: FakeProc, sessionId: string, text = 'hi there') {
  proc.stdout.write(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n',
  );
  proc.stdout.write(
    JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text }] },
    }) + '\n',
  );
  proc.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
    }) + '\n',
  );
  proc.emit('close', 0);
}

/**
 * Wait for the runner to have spawned attempt #n, then drive it. The runner
 * spawns synchronously inside a promise executor, but stream `data` handlers
 * are async, so yield to the microtask/macrotask queue between steps.
 */
async function nextTick() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  spawnCalls.length = 0;
  vi.clearAllMocks();
});

describe('runHostClaudeAgent — happy path', () => {
  it('spawns once with --resume and returns the streamed session id', async () => {
    const sent: string[] = [];
    const promise = runHostClaudeAgent(
      group,
      { ...input, sessionId: 'stored-id' },
      () => {},
      async (out) => {
        if (out.result) sent.push(out.result);
      },
    );

    await nextTick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['--resume', 'stored-id']));

    emitSuccess(spawnCalls[0], 'fresh-id');
    const out = await promise;

    expect(spawnCalls).toHaveLength(1);
    expect(out.status).toBe('success');
    expect(out.newSessionId).toBe('fresh-id');
    expect(sent).toEqual(['hi there']);
  });

  it('spawns without --resume when no sessionId is stored', async () => {
    const promise = runHostClaudeAgent(group, input, () => {});

    await nextTick();
    expect(spawnCalls[0].args).not.toContain('--resume');

    emitSuccess(spawnCalls[0], 'brand-new-id');
    const out = await promise;

    expect(out.status).toBe('success');
    expect(out.newSessionId).toBe('brand-new-id');
  });
});
```

**Step 2: Run to verify it passes against the CURRENT implementation**

```bash
npx vitest run src/host-claude-runner-run.test.ts
```

Expected: **PASS.** This is a characterization test — it documents existing behavior, so it must be green before any refactor.

If it fails, do not "fix" the source. Fix the test until it accurately describes what the code does today. Common causes: not enough `await nextTick()` between writing to `stdout` and emitting `close`; a real `fs` call escaping the mock.

**Step 3: Commit**

```bash
jj describe -m "test: characterize runHostClaudeAgent happy path with a spawn mock harness"
jj new
```

---

## Task 3: Refactor `runHostClaudeAgent` into an inner `attempt()` — no behavior change

Pure structural refactor. Tests from Task 2 must stay green with no edits.

**Files:**
- Modify: `src/host-claude-runner.ts:114-455`

**Step 1: Restructure the function**

Change the signature body so everything from `const startTime` through the directory setup, `writeMcpConfig`, `readOauthToken`, and `logsDir` stays in the outer function (it is per-run setup, not per-attempt). Then wrap the `return new Promise(...)` block in an inner function.

Add this type above `runHostClaudeAgent`:

```ts
/** One `claude` spawn's outcome, plus the raw signals needed to decide on a retry. */
interface AttemptResult {
  output: ContainerOutput;
  stdout: string;
  stderr: string;
  hadStreamingOutput: boolean;
}
```

Then, inside `runHostClaudeAgent`, replace `return new Promise((resolve) => {` with:

```ts
  const attempt = (sessionId: string | undefined, attemptNo: number): Promise<AttemptResult> =>
    new Promise((resolve) => {
      const args = buildClaudeArgs({ sessionId, projectRoot: process.cwd() });
      const name = `nanoclaw-host-${safeName}-${Date.now()}${
        attemptNo > 1 ? `-retry${attemptNo}` : ''
      }`;

      logger.info(
        { group: group.name, name, isMain: input.isMain, resume: !!sessionId, attemptNo },
        'Spawning host claude agent',
      );

      /** Resolve with the ContainerOutput plus the signals the retry check needs. */
      const finish = (output: ContainerOutput) =>
        resolve({ output, stdout, stderr, hadStreamingOutput });

      // ... existing body ...
    });
```

Apply these mechanical edits inside the moved body:

| Current | Becomes |
|---|---|
| `const args = buildClaudeArgs({ sessionId: input.sessionId, ... })` (line 144) | deleted — now computed inside `attempt` from the `sessionId` parameter |
| `const name = ...` (line 146) | deleted — now computed inside `attempt` |
| the `logger.info('Spawning host claude agent')` call (lines 159-162) | deleted — now inside `attempt` |
| every `resolve({ ... })` inside the promise body | `finish({ ... })` |
| the image-cleanup block in `child.on('close')` (lines 296-312) | **deleted** — moves to the outer function (Step 2) |

Keep `const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');` in the **outer** function (it does not vary per attempt).

`stdout`, `stderr`, `hadStreamingOutput`, `newSessionId`, `sawError`, `timedOut`, `outputChain`, the parser, and the timeout state all stay **inside** `attempt` — each attempt needs its own.

Note the two `outputChain.then(...)` sites now call `finish(...)` instead of `resolve(...)`.

**Step 2: Add the outer body**

After the `attempt` definition, add:

```ts
  /** Delete images the prompt referenced. Runs once, after the final attempt. */
  const cleanupImages = () => {
    const imagesDir = path.join(groupIpcDir, 'images');
    try {
      const imageFiles = fs.readdirSync(imagesDir);
      for (const file of imageFiles) {
        try {
          fs.unlinkSync(path.join(imagesDir, file));
        } catch {
          /* ignore */
        }
      }
      if (imageFiles.length > 0) {
        logger.debug({ group: group.name, count: imageFiles.length }, 'Cleaned up IPC images');
      }
    } catch {
      /* images dir may not exist */
    }
  };

  const first = await attempt(input.sessionId, 1);
  cleanupImages();
  return first.output;
```

`runHostClaudeAgent` is already declared `async`, so the `await` is fine.

**Step 3: Typecheck and run all tests**

```bash
npm run build && npx vitest run
```

Expected: build clean; `host-claude-runner-run.test.ts` and `host-claude-runner.test.ts` PASS with **no test edits**. The 6 pre-existing `formatting.test.ts` failures (hardcoded `@Andy` vs `ASSISTANT_NAME=Taskie`) are known and unrelated — leave them.

**Step 4: Commit**

```bash
jj describe -m "refactor: extract per-attempt spawn body in runHostClaudeAgent (no behavior change)"
jj new
```

---

## Task 4: Retry once with a fresh session on stale-session failure

**Files:**
- Modify: `src/host-claude-runner.ts` (the outer body added in Task 3)
- Test: `src/host-claude-runner-run.test.ts`

**Step 1: Write the failing test**

Add this helper next to `emitSuccess`:

```ts
/** Emit the stale-session failure: stderr message, no stdout, exit 1. */
function emitStaleSessionFailure(proc: FakeProc, staleId: string) {
  proc.stderr.write(`No conversation found with session ID: ${staleId}\n`);
  proc.emit('close', 1);
}
```

Add this `describe` block:

```ts
describe('runHostClaudeAgent — stale session recovery', () => {
  it('retries once without --resume and returns the new session id', async () => {
    const sent: string[] = [];
    const registered: string[] = [];
    const promise = runHostClaudeAgent(
      group,
      { ...input, sessionId: 'stale-id' },
      (_proc, name) => registered.push(name),
      async (out) => {
        if (out.result) sent.push(out.result);
      },
    );

    await nextTick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['--resume', 'stale-id']));

    emitStaleSessionFailure(spawnCalls[0], 'stale-id');
    await nextTick();

    // Exactly one retry, with no --resume.
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1].args).not.toContain('--resume');
    expect(spawnCalls[1].args).not.toContain('stale-id');

    emitSuccess(spawnCalls[1], 'recovered-id', 'recovered reply');
    const out = await promise;

    expect(spawnCalls).toHaveLength(2);
    expect(out.status).toBe('success');
    expect(out.newSessionId).toBe('recovered-id');
    expect(sent).toEqual(['recovered reply']);
    // Each attempt registers a distinct process name with the group queue.
    expect(new Set(registered).size).toBe(2);
  });

  it('surfaces the error without a third spawn when the fresh attempt also fails', async () => {
    const promise = runHostClaudeAgent(group, { ...input, sessionId: 'stale-id' }, () => {});

    await nextTick();
    emitStaleSessionFailure(spawnCalls[0], 'stale-id');
    await nextTick();

    expect(spawnCalls).toHaveLength(2);
    spawnCalls[1].stderr.write('Invalid API key\n');
    spawnCalls[1].emit('close', 1);

    const out = await promise;
    expect(spawnCalls).toHaveLength(2);
    expect(out.status).toBe('error');
    expect(out.error).toContain('Invalid API key');
  });

  it('does not retry a stale-session failure that repeats (no infinite loop)', async () => {
    const promise = runHostClaudeAgent(group, { ...input, sessionId: 'stale-id' }, () => {});

    await nextTick();
    emitStaleSessionFailure(spawnCalls[0], 'stale-id');
    await nextTick();
    // Second attempt reports the same message — must NOT trigger a third spawn.
    emitStaleSessionFailure(spawnCalls[1], 'stale-id');

    const out = await promise;
    expect(spawnCalls).toHaveLength(2);
    expect(out.status).toBe('error');
  });
});
```

**Step 2: Run to verify it fails**

```bash
npx vitest run src/host-claude-runner-run.test.ts
```

Expected: FAIL — the first test times out or asserts `spawnCalls` length 1, because no retry happens yet.

**Step 3: Implement**

In `src/host-claude-runner.ts`, replace the three-line outer body from Task 3 Step 2 with:

```ts
  const first = await attempt(input.sessionId, 1);

  // Self-heal a stale `--resume` id: claude exits non-zero with "No conversation
  // found with session ID" when the stored id is not in the host session store
  // (config dir recreated, history pruned, container->host migration leftovers).
  // Without this, index.ts rolls the cursor back and retries with the SAME id
  // forever — exponential backoff, no reply ever delivered.
  //
  // Retried at most ONCE, and only when nothing was streamed to the user yet:
  // onOutput posts text incrementally, so retrying after partial output would
  // double-post to the chat.
  if (
    input.sessionId &&
    first.output.status === 'error' &&
    !first.hadStreamingOutput &&
    isStaleSessionError(first.stderr + first.stdout)
  ) {
    logger.warn(
      { group: group.name, staleSessionId: input.sessionId },
      'Stored session id not found by claude; retrying once with a fresh session',
    );
    // No --resume: yields a new session_id, which index.ts persists over the
    // stale one via the normal newSessionId path (src/index.ts:292-294).
    const retried = await attempt(undefined, 2);
    cleanupImages();
    return retried.output;
  }

  cleanupImages();
  return first.output;
```

**Step 4: Run to verify it passes**

```bash
npx vitest run src/host-claude-runner-run.test.ts && npm run build
```

Expected: all 5 tests in the file PASS; build clean.

**Step 5: Commit**

```bash
jj describe -m "fix: host claude self-heals a stale --resume session id instead of crash-looping"
jj new
```

---

## Task 5: Guard tests — cases that must NOT retry

The retry is deliberately narrow. These tests pin the guards so a later refactor can't widen it.

**Files:**
- Test: `src/host-claude-runner-run.test.ts`

**Step 1: Write the tests**

```ts
describe('runHostClaudeAgent — retry guards', () => {
  it('does not retry when no session id was passed', async () => {
    const promise = runHostClaudeAgent(group, input, () => {});

    await nextTick();
    // Defensive: even if the message somehow appears, there is no stale id to drop.
    spawnCalls[0].stderr.write('No conversation found with session ID: ???\n');
    spawnCalls[0].emit('close', 1);

    const out = await promise;
    expect(spawnCalls).toHaveLength(1);
    expect(out.status).toBe('error');
  });

  it('does not retry an unrelated failure', async () => {
    const promise = runHostClaudeAgent(group, { ...input, sessionId: 'stored-id' }, () => {});

    await nextTick();
    spawnCalls[0].stderr.write('Error: connection reset by peer\n');
    spawnCalls[0].emit('close', 1);

    const out = await promise;
    expect(spawnCalls).toHaveLength(1);
    expect(out.status).toBe('error');
  });

  it('does not retry after text has already been streamed to the chat', async () => {
    const sent: string[] = [];
    const promise = runHostClaudeAgent(
      group,
      { ...input, sessionId: 'stored-id' },
      () => {},
      async (out) => {
        if (out.result) sent.push(out.result);
      },
    );

    await nextTick();
    // Partial reply reaches the user, THEN the process dies with the message.
    spawnCalls[0].stdout.write(
      JSON.stringify({
        type: 'assistant',
        session_id: 'stored-id',
        message: { content: [{ type: 'text', text: 'partial answer' }] },
      }) + '\n',
    );
    await nextTick();
    spawnCalls[0].stderr.write('No conversation found with session ID: stored-id\n');
    spawnCalls[0].emit('close', 1);

    const out = await promise;
    // Retrying here would post the whole reply a second time.
    expect(spawnCalls).toHaveLength(1);
    expect(out.status).toBe('error');
    expect(sent).toEqual(['partial answer']);
  });
});
```

**Step 2: Run**

```bash
npx vitest run src/host-claude-runner-run.test.ts
```

Expected: PASS — the guards were implemented in Task 4, so these should be green immediately. If any fails, the Task 4 condition is wrong; fix `host-claude-runner.ts`, not the test.

**Step 3: Full suite**

```bash
npx vitest run
```

Expected: only the 6 known `formatting.test.ts` failures (`@Andy` vs `ASSISTANT_NAME=Taskie`). Everything else green.

**Step 4: Commit**

```bash
jj describe -m "test: pin the stale-session retry guards (no id, unrelated error, already streamed)"
jj new
```

---

## Task 6: Manual verification against the real service

Automated tests use a fake spawn. Confirm the real `claude` CLI produces the message this fix keys on.

**Step 1: Confirm the error string from the real binary**

```bash
CLAUDE_CONFIG_DIR="$PWD/data/sessions/main/.claude" \
  /Users/ballen/.local/bin/claude -p --resume 00000000-0000-0000-0000-000000000000 \
  <<< 'hi' 2>&1 | tail -5
```

Expected: text containing `No conversation found with session ID`. **If the wording differs, update the regex in `isStaleSessionError` and its tests before continuing** — the whole fix hinges on this string.

**Step 2: End-to-end against a bogus stored id**

```bash
npm run build
sqlite3 store/messages.db \
  "UPDATE sessions SET session_id='00000000-0000-0000-0000-000000000000' WHERE group_folder='main';"
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Send one Telegram message to the main group. Expected:
- A reply arrives (one reply, not two).
- Logs show `Stored session id not found by claude; retrying once with a fresh session` exactly once.
- No backoff-retry sequence (no 5s/10s/20s/40s pattern).

**Step 3: Confirm the new id was persisted**

```bash
sqlite3 store/messages.db "SELECT group_folder, session_id FROM sessions WHERE group_folder='main';"
```

Expected: a real UUID, not the zeros. Send a second message and confirm the log line does **not** reappear (it now resumes a valid session).

**Step 4: Update the spec's status line**

In `docs/plans/2026-07-26-telegram-stale-session-crashloop-fix.md`, change line 3:

```markdown
**Status:** Implemented (2026-07-26) · **Scope:** small, self-contained · **Owner:** (unassigned)
```

Add a line under it pointing at this plan and noting the implementation deviated from the spec in one way worth recording:

```markdown
Implemented per `docs/plans/2026-07-26-telegram-stale-session-crashloop-fix-plan.md`.
Beyond the spec, the retry is additionally gated on "nothing streamed to the user yet"
so a mid-reply failure can never double-post to the chat.
```

**Step 5: Commit**

```bash
jj describe -m "docs: mark stale-session crash-loop fix implemented"
jj new
```

---

## Out of scope

- The interactive Remote Control ("Taskie") endpoint — separate work.
- Non-main container groups (`src/container-runner.ts`) — the SDK has different resume semantics.
- The backoff/retry mechanism in `src/index.ts` — it stays as the general safety net; this fix removes the trigger.
- Preserving conversation context across the recovery. The fresh session starts empty by design; carrying context forward would need a transcript-replay mechanism that does not exist.
