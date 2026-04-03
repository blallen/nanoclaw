# Fix Double-Response Issue

## Problem

Taskie sends duplicate messages to Telegram for a single user query. Two independent paths both deliver content:

1. **Streaming output**: The agent-runner forwards every SDK `result` message (including subagent results from agent teams) to the host, which sends each one to Telegram.
2. **IPC `send_message`**: The agent uses the `send_message` MCP tool to deliver content mid-stream. The host's IPC watcher sends this independently. Then the SDK's final `result` is also sent — duplicating the response.

Both paths were introduced in the same commit (`6f02ee5` — "Adds Agent Swarms") and the interaction between them was never guarded.

## Design

### Suppress SDK result when `send_message` was used

The MCP server (`ipc-mcp-stdio.ts`) writes a `_sent` sentinel file when `send_message` is called. The agent-runner checks for this sentinel when processing each SDK `result` message. If the sentinel exists, the result text is suppressed (emitted as `null`). If not, the result text is forwarded normally.

This ensures: if the agent used `send_message` to deliver content, the SDK's final result doesn't duplicate it.

### Communication mechanism

The MCP server runs as a child process spawned by the SDK, not in the same process as the agent-runner. The sentinel file (`/workspace/ipc/input/_sent`) follows the existing IPC file pattern used by `_close`. The agent-runner clears stale sentinels on startup and at the start of each query turn.

### Host-side idle timer fix

The host-side callback (`src/index.ts`) previously only reset the container idle timer when a non-null result arrived. This was changed to reset on ALL output markers (including null results) so the container stays alive while the agent-runner processes results.

## Data Flow (after fix)

```
SDK result → agent-runner checks _sent sentinel
  if _sent exists → writeOutput({result: null})  → host resets idle timer, nothing sent to user
  if _sent absent → writeOutput({result: text})  → host sends to Telegram
send_message IPC → writes _sent sentinel + host sends to Telegram independently
```

## Scope

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Check `_sent` sentinel on each result; clear stale sentinels on startup |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Write `_sent` sentinel when `send_message` is called |
| `src/index.ts` | Reset idle timer on all output markers, not just non-null results |
| `groups/main/CLAUDE.md` | Document send_message suppression behavior |
| `groups/global/CLAUDE.md` | Document send_message suppression behavior |

## Edge Cases

1. **Agent uses `send_message` AND final result has content**: Final result suppressed. By design — if you use `send_message`, you own delivery.
2. **Single result, no `send_message`**: Works exactly as before — result text forwarded to user.
3. **Subagent uses `send_message`**: Sends to Telegram via IPC, sets sentinel, subsequent results suppressed.
4. **Scheduled tasks**: Consistent — `send_message` is already the documented way to communicate from scheduled tasks.
5. **Multi-turn query loop**: Sentinel cleared at start of each `runQuery` call. Each turn is independent.
6. **Agent teams subagent results (no send_message)**: Still emitted individually. Future improvement: accumulate and only emit the orchestrator's final result.
