# Fix: Telegram stale-session crash loop (host harness)

**Status:** Ready to implement · **Scope:** small, self-contained · **Owner:** (unassigned)

## Context (for a fresh chat)

The **main** group ("Taskie") now runs as a **host `claude` CLI harness** (not the old Apple Container). The relevant runner is `src/host-claude-runner.ts` (`runHostClaudeAgent` / `buildClaudeArgs`); `chooseRunner` in `src/runner-selection.ts` routes `main` to it, and `src/index.ts` (`runAgent`) invokes it and persists the returned session id. Session ids are stored per-group in the `sessions` table of `store/messages.db` (via `src/db.ts` `setSession`/`getAllSessions`) and cached in an in-memory `sessions` map in `index.ts`, loaded once at startup by `loadState()`.

Each turn, the runner passes `--resume <sessionId>` to `claude` (see `buildClaudeArgs`) when a stored id exists.

## Problem (observed in production)

When the stored session id does **not** exist in the host `claude` session history (`CLAUDE_CONFIG_DIR=data/sessions/main/.claude`), `claude` exits **code 1** with:

```
No conversation found with session ID: <uuid>
```

`runAgent` treats this as an agent error → the group's message cursor is rolled back → the message is **retried with exponential backoff** (observed: 5s, 10s, 20s, 40s, 80s…). But the retry re-reads the **same stale id** from the in-memory `sessions` map and passes `--resume <same stale id>` again — so every retry fails identically. **Infinite crash loop; the user never gets a reply.**

This was first hit during the container→host migration (a leftover *container/SDK-era* session id that doesn't exist in the new host session store). We hot-fixed it by `DELETE`-ing the `main` row from `sessions` and restarting the service (restart reloads the now-empty map → fresh session). But it will **recur** any time a stored id becomes invalid: host session store pruned/cleared, config dir recreated, session expiry, etc. It should self-heal.

## Root cause

`--resume` is passed unconditionally when a stored id exists, with **no fallback** when that id is missing/invalid. The retry path re-uses the cached stale id instead of discarding it.

## Proposed fix (runner-level, minimal blast radius)

In `src/host-claude-runner.ts`, detect the session-not-found condition and transparently recover **once**:

1. Detect it: `claude` exited non-zero AND stderr matches `/No conversation found with session ID/i` AND a `sessionId` was passed.
2. On that condition, **re-spawn the same prompt once without `--resume`** (fresh session). Do NOT loop more than once — if the fresh spawn also fails, return the error normally.
3. The fresh spawn yields a new `newSessionId` via the existing stream parser; return it as usual so `index.ts` persists it (overwriting the stale id in both the in-memory map and the DB through the normal `newSessionId` path). No direct DB writes needed in the runner.

Keeping the fix in the runner means the orchestrator's error/retry-backoff path never triggers for this case, so no other code changes are required. (Optionally, also clear the in-memory/DB id defensively in `index.ts` if the runner signals "session was invalid", but the `newSessionId` overwrite already covers it.)

## Files

- `src/host-claude-runner.ts` — add the detect-and-retry-fresh logic in `runHostClaudeAgent` (around the child `close`/error handling where the non-zero exit + stderr are available).
- `src/host-claude-runner.test.ts` — add a unit test (see below).
- No change expected to `container-runner.ts` (non-main groups use the SDK, which has different resume semantics). If desired, note the difference rather than touching it.

## Acceptance criteria

- Given a stored session id that `claude` reports as not found, a single inbound message results in **exactly one** transparent fresh-session spawn, a successful reply, and the **new valid** session id persisted to `store/messages.db`. No backoff-retry loop, no user-visible failure.
- A subsequent message `--resume`s the new (valid) id normally.
- If the fresh spawn itself fails for an unrelated reason, the error surfaces as before (no infinite loop).

## Test plan

- Unit: inject a fake spawn/stream that, on first call (with `--resume`), emits the `No conversation found with session ID` stderr + exit 1, and on the second call (no `--resume`) emits a normal `system/init` + `assistant` + `result`. Assert: the runner made exactly two spawns, the second had no `--resume`, and it returned `{status:'success', newSessionId:<new>}`.
- Manual (optional): set `sessions.main` to a bogus UUID in `store/messages.db`, restart, send a Telegram message, confirm one recovery + reply and that `sessions.main` is updated to a real id.

## Out of scope

- The interactive Remote Control ("Taskie") endpoint (separate work).
- Non-main container groups.
- Any change to the backoff/retry mechanism itself (the fix prevents the trigger; the backoff stays as a general safety net).

## Reference: hot-fix used before the permanent fix exists

```bash
# stop the loop for main by clearing its stale session, then restart (reloads clean state)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='main';"
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
