# Fix Double-Response Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent Taskie from sending duplicate messages to Telegram when the agent uses `send_message` or agent teams produce multiple SDK results.

**Architecture:** Two changes in the agent-runner (container side only). (1) Accumulate SDK results during a query and only emit the final one to the host. (2) Detect when the MCP `send_message` tool was used during a query and suppress the final SDK result, since the agent already delivered content directly.

**Tech Stack:** TypeScript, Node.js, file-based IPC sentinels

**Design doc:** `docs/plans/2026-04-03-fix-double-response-design.md`

---

### Task 1: Add `_sent` sentinel to `ipc-mcp-stdio.ts`

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:49-62`

**Step 1: Add the sentinel constant and write logic**

At the top of the file, after the existing constants (line 14-16), add:

```typescript
const IPC_SENT_SENTINEL = path.join(IPC_DIR, 'input', '_sent');
```

In the `send_message` handler (line 49-62), after the `writeIpcFile` call, write the sentinel:

```typescript
// Signal to agent-runner that send_message was used this turn
fs.writeFileSync(IPC_SENT_SENTINEL, '');
```

**Step 2: Verify the change compiles**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```
jj describe -m "feat: write _sent sentinel when send_message MCP tool is used"
jj new
```

---

### Task 2: Accumulate results and check `_sent` sentinel in `runQuery`

**Files:**
- Modify: `container/agent-runner/src/index.ts:57-58` (add constant)
- Modify: `container/agent-runner/src/index.ts:481-490` (result handling loop)
- Modify: `container/agent-runner/src/index.ts:492-495` (post-loop emit)

**Step 1: Add the sentinel constant**

After the existing `IPC_INPUT_CLOSE_SENTINEL` constant (line 58), add:

```typescript
const IPC_SENT_SENTINEL = path.join(IPC_INPUT_DIR, '_sent');
```

**Step 2: Add a helper to check and clear the `_sent` sentinel**

After the existing `shouldClose()` function (around line 293), add:

```typescript
/**
 * Check if send_message was used during this query turn.
 * Consumes the sentinel so subsequent turns start clean.
 */
function checkAndClearSentFlag(): boolean {
  if (fs.existsSync(IPC_SENT_SENTINEL)) {
    try { fs.unlinkSync(IPC_SENT_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}
```

**Step 3: Clear stale `_sent` sentinel at query start**

At the top of `runQuery` (after `stream.push(prompt)` on line 365), add:

```typescript
// Clean up stale _sent sentinel from previous turn
try { fs.unlinkSync(IPC_SENT_SENTINEL); } catch { /* ignore */ }
```

**Step 4: Modify the result handling inside the `for await` loop**

Replace the current result block (lines 481-490):

```typescript
    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
```

With:

```typescript
    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      // Accumulate last result text; emit null to keep idle timer alive
      if (textResult) lastResultText = textResult;
      writeOutput({
        status: 'success',
        result: null,
        newSessionId
      });
    }
```

**Step 5: Add the `lastResultText` variable and post-loop emit**

Declare `lastResultText` alongside the other tracking variables (after `let resultCount = 0;` on line 391):

```typescript
let lastResultText: string | null = null;
```

After the `for await` loop ends (after `ipcPolling = false;` on line 493), before the return statement, add:

```typescript
// Emit the final accumulated result (or suppress if send_message was used)
const wasSent = checkAndClearSentFlag();
if (lastResultText && !wasSent) {
  log('Emitting final accumulated result to host');
  writeOutput({ status: 'success', result: lastResultText, newSessionId });
} else if (wasSent) {
  log('Suppressing final result — send_message was used during this query');
} else {
  log('No result text accumulated');
}
```

**Step 6: Verify the change compiles**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```
jj describe -m "feat: accumulate SDK results and suppress when send_message used"
jj new
```

---

### Task 3: Clean up stale `_sent` sentinel in main entrypoint

**Files:**
- Modify: `container/agent-runner/src/index.ts:568-569` (main function, near `_close` cleanup)

**Step 1: Add cleanup alongside existing `_close` cleanup**

After the existing line that cleans up the stale `_close` sentinel (line 569):

```typescript
// Clean up stale _close sentinel from previous container runs
try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
```

Add:

```typescript
// Clean up stale _sent sentinel from previous container runs
try { fs.unlinkSync(IPC_SENT_SENTINEL); } catch { /* ignore */ }
```

**Step 2: Commit**

```
jj describe -m "chore: clean up stale _sent sentinel on container startup"
jj new
```

---

### Task 4: Rebuild container and test

**Step 1: Build the agent-runner**

Run: `cd container/agent-runner && npx tsc`
Expected: Clean compile, no errors

**Step 2: Rebuild the container image**

Run: `./container/build.sh`
Expected: Successful build

**Step 3: Verify the updated source is in the container**

Run: `container run -i --rm --entrypoint grep nanoclaw-agent:latest -c "IPC_SENT_SENTINEL" /app/src/index.ts`
Expected: At least 1 match (the agent-runner source is mounted from host, but verify the constant exists)

**Step 4: Manual integration test**

Send a message to Taskie via Telegram. Verify:
- Single response received (not duplicated)
- Response content is correct
- Container logs show "Emitting final accumulated result" or "Suppressing final result"

Check logs: `tail -20 groups/main/logs/container-*.log | sort | tail -20`

**Step 5: Commit any final adjustments**

```
jj describe -m "feat: fix double-response — accumulate results, suppress on send_message"
jj new
```

---

### Task 5: Update agent CLAUDE.md instructions

**Files:**
- Modify: `groups/main/CLAUDE.md`
- Modify: `groups/global/CLAUDE.md`

**Step 1: Update the `send_message` documentation**

In `groups/main/CLAUDE.md`, find the `send_message` description and update to note that using it suppresses the final result:

> You also have `mcp__nanoclaw__send_message` which sends a message immediately while you're still working. This is useful when you want to acknowledge a request before starting longer work. **When you use `send_message`, your final output is automatically suppressed to avoid duplicates — so make sure `send_message` delivers everything the user needs to see.**

Apply the same update to `groups/global/CLAUDE.md`.

**Step 2: Commit**

```
jj describe -m "docs: update CLAUDE.md to document send_message suppression behavior"
jj new
```
