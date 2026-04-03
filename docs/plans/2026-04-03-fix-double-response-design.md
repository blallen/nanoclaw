# Fix Double-Response Issue

## Problem

Taskie sends duplicate messages to Telegram for a single user query. Two independent paths both deliver content:

1. **Streaming output**: The agent-runner forwards every SDK `result` message (including subagent results from agent teams) to the host, which sends each one to Telegram.
2. **IPC `send_message`**: The agent uses the `send_message` MCP tool to deliver content mid-stream. The host's IPC watcher sends this independently. Then the SDK's final `result` is also sent — duplicating the response.

Both paths were introduced in the same commit (`6f02ee5` — "Adds Agent Swarms") and the interaction between them was never guarded.

## Design

Two changes, both in the agent-runner (`container/agent-runner/src/index.ts`). No host-side changes.

### Change 1: Accumulate results, emit once

Inside `runQuery`, stop calling `writeOutput({result: text})` on every `message.type === 'result'`. Instead:

- Intermediate results: emit `writeOutput({result: null})` to keep the host's idle timer alive
- Accumulate the last non-null result text in a local variable
- After the `for await` loop ends, emit a single `writeOutput({result: lastResultText})` with the final text

This ensures subagent results never reach the user — only the orchestrator's final result does.

### Change 2: Suppress final result when `send_message` was used

Add a module-level `ipcMessageSent` flag. The `send_message` handler in `ipc-mcp-stdio.ts` sets this flag when called. After the query loop in `runQuery`:

- If `ipcMessageSent` is true: emit `writeOutput({result: null})` — the agent already sent what it wanted
- If `ipcMessageSent` is false: emit `writeOutput({result: lastResultText})` as normal

The flag resets at the start of each `runQuery` call so multi-turn sessions work correctly.

### Communication between MCP server and agent-runner

The MCP server (`ipc-mcp-stdio.ts`) runs as a child process spawned by the SDK, not in the same process as the agent-runner. The simplest signaling mechanism: the `send_message` handler writes a sentinel file (e.g., `/workspace/ipc/input/_sent`) that the agent-runner checks after the query completes. This follows the existing IPC file pattern used by `_close`.

## Data Flow (after fix)

```
SDK result #1 (subagent) → writeOutput({result: null}) → idle timer reset only
SDK result #2 (subagent) → writeOutput({result: null}) → idle timer reset only
SDK result #3 (orchestrator) → accumulated as lastResultText
for-await loop ends → check ipcMessageSent
  if true  → writeOutput({result: null})     → nothing sent to user
  if false → writeOutput({result: lastText}) → host sends to Telegram
send_message IPC → host sends to Telegram (as before, independently)
```

## Scope

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Accumulate results in `runQuery`, emit once; check `_sent` sentinel |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Write `_sent` sentinel when `send_message` is called |

No changes to: `src/index.ts`, `src/container-runner.ts`, `src/group-queue.ts`, `src/ipc.ts`.

## Edge Cases

1. **Agent uses `send_message` AND final result has content**: Final result suppressed. By design — if you use `send_message`, you own delivery.
2. **Single result, no `send_message`**: Works exactly as before.
3. **Subagent uses `send_message`**: Sends to Telegram via IPC, sets flag, orchestrator result suppressed. Correct — content already delivered.
4. **Scheduled tasks**: Consistent — `send_message` is already the documented way to communicate from scheduled tasks.
5. **Multi-turn query loop**: Flag resets per `runQuery` call. Each turn is independent.
