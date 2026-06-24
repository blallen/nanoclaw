# Host Claude Code Harness Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run the Taskie (main) agent as a host-run Claude Code harness operating in the `groups/main` workspace, driven by both Telegram (automated, headless) and the Claude mobile app (Remote Control) over one shared workspace, retiring the ephemeral Apple Container for the main path.

**Architecture:** Replace the in-container Claude Agent SDK runner with a host process that spawns `claude` in print/stream-json mode against `groups/main`. The existing `nanoclaw` IPC tools, `src/ipc.ts` watcher, SQLite session store, scheduler, and `GroupQueue` are reused; only the runner changes. Non-main groups keep the container path unchanged. A second launchd-managed `claude remote-control` process attaches the phone to the same workspace.

**Tech Stack:** Node.js + TypeScript, vitest, Claude Code CLI 2.1.190 (`claude`), `@modelcontextprotocol/sdk` stdio server, Apple Container (retained for non-main only), launchd.

**Design doc:** `docs/plans/2026-06-24-host-claude-harness-migration-design.md`

---

## Task 0 ground truth (spike complete — verified on claude 2.1.190)

These facts are confirmed; build against them (full notes: `docs/plans/scratch-claude-cli-notes.md`).

- **Flags:** `-p`, `--output-format stream-json` (+ `--verbose`), `--input-format stream-json`, `-r/--resume <id>`, `--permission-mode bypassPermissions` (use for unattended), `--strict-mcp-config`. `claude remote-control` is real (`--name`, `--spawn same-dir` default, `--permission-mode`).
- **stream-json shapes:** `system/init` carries `session_id` (+ `model`, `mcp_servers`, `plugins`); `assistant` carries `message.content[].text`; terminal `result` (`subtype:"success"`) carries the full `result` text + `session_id`. Ignore `system/hook_*`, `rate_limit_event`, `system/post_turn_summary`.
- **Resume:** `--resume <id>` reuses the **same** session_id and recalls context → `db.ts` keeps one stable id per group.
- **CONFIG ISOLATION (decided):** a default host run inherits the user's `~/.claude` (superpowers hook, personal MCP, 1M-ctx opus, $0.11/one-word reply). **Both Taskie processes must set `CLAUDE_CONFIG_DIR=<abs>/data/sessions/main/.claude`** (the existing per-group dir). Verified: this yields `mcp_servers: []`, `plugins: []`, no superpowers hook. A fresh config dir is **not logged in** — it must be authenticated once (see Task 1b). Project-level `groups/main/.claude/` + `groups/main/.mcp.json` still load and carry Taskie's hooks/MCP/skills. The user's personal Claude Code (default `~/.claude`) is untouched.

---

## Conventions for this plan

- Tests are vitest, colocated as `src/<name>.test.ts`. Run a single file with `npx vitest run src/<name>.test.ts`.
- Model new runner tests on the existing `src/container-runner.test.ts`.
- Commit after each task. This repo is a git worktree on branch `claude/serene-hugle-f8a373`; use **git** here (not jj — jj resolves to the main workspace in this worktree).
- "Verify" steps are manual/integration checks where unit TDD does not fit (spawning `claude`, Remote Control, launchd). Do them and paste real output; do not assert success without it (superpowers:verification-before-completion).

---

## Task 0: Spike — establish ground-truth `claude` CLI behavior

No code. De-risk every later task by confirming exact flags and event shapes for THIS installed version (2.1.190). Record findings in a scratch file `docs/plans/scratch-claude-cli-notes.md` (deleted in the final task).

**✅ COMPLETE.** Findings recorded in the "Task 0 ground truth" section above and `docs/plans/scratch-claude-cli-notes.md`. Gate passed: stream-json shapes match assumptions and `remote-control` is real. One material addition surfaced — **config isolation via `CLAUDE_CONFIG_DIR`** — now threaded through Tasks 1b/3/4/6.

---

## Task 1b: Authenticate Taskie's isolated config dir (setup, one-time)

Before any host `claude` run can work isolated, the dedicated config dir needs credentials.

**Files:** none in-repo (operational setup) + a short section in `docs/MY-SETUP.md`.

**Step 1: Authenticate the dir**

```bash
mkdir -p data/sessions/main/.claude
CLAUDE_CONFIG_DIR="$(pwd)/data/sessions/main/.claude" claude setup-token
# (or: CLAUDE_CONFIG_DIR=... claude  → /login once)
```

**Step 2: Verify it is logged in and isolated**

```bash
CLAUDE_CONFIG_DIR="$(pwd)/data/sessions/main/.claude" claude -p "Reply with: AUTH_OK" \
  --output-format stream-json --verbose --permission-mode bypassPermissions 2>/dev/null \
  | python3 -c 'import sys,json
for l in sys.stdin:
    try: o=json.loads(l)
    except: continue
    if o.get("type")=="system" and o.get("subtype")=="init":
        print("mcp:",[m["name"] for m in o.get("mcp_servers",[])],"plugins:",[p["name"] for p in o.get("plugins",[])])
    if o.get("type")=="result": print("result:",repr(o.get("result")),"cost:",o.get("total_cost_usd"))'
```
Expected: `mcp: [] plugins: []` (until Task 4 adds the project `.mcp.json`), `result: 'AUTH_OK'`, non-zero cost (proves authed). Document the auth step in `docs/MY-SETUP.md` and commit that doc change.

**Note:** This dir already exists and is populated by `container-runner.ts:buildVolumeMounts` (settings.json with agent-teams env, skills sync). The host model reuses it as the user-config dir. Decide in Task 4 whether to keep writing that settings.json from the runner or commit it statically.

---

## Task 1: Host-runnable `nanoclaw` MCP server

The container MCP (`container/agent-runner/src/ipc-mcp-stdio.ts`) hardcodes `/workspace/ipc` and stays in service for non-main groups — do not modify it. Create a host twin that reads its IPC dir + context from env vars and writes to the host IPC path `data/ipc/main/`.

**Files:**
- Create: `src/nanoclaw-mcp-server.ts`
- Create: `src/nanoclaw-mcp-server.test.ts`

**Step 1: Write failing tests for the IPC-write helper**

Extract the IPC-path/file-write behavior into a testable function. Test:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeIpcFile, resolveIpcDir } from './nanoclaw-mcp-server.js';

describe('nanoclaw-mcp-server IPC writes', () => {
  it('resolveIpcDir uses NANOCLAW_IPC_DIR when set', () => {
    expect(resolveIpcDir({ NANOCLAW_IPC_DIR: '/tmp/x' })).toBe('/tmp/x');
  });

  it('writeIpcFile writes an atomically-renamed JSON file into the target dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ipc-'));
    const name = writeIpcFile(dir, { type: 'message', text: 'hi' });
    const written = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
    expect(written).toMatchObject({ type: 'message', text: 'hi' });
    expect(fs.existsSync(path.join(dir, `${name}.tmp`))).toBe(false);
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run src/nanoclaw-mcp-server.test.ts`
Expected: FAIL — module/exports not found.

**Step 3: Implement the host MCP server**

Port the tool set from `container/agent-runner/src/ipc-mcp-stdio.ts` (`send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `register_group`, `list/add/remove/restart/restart_all_mcp_servers`). Changes from the container version:
- `const IPC_DIR = resolveIpcDir(process.env)` where `resolveIpcDir(env) => env.NANOCLAW_IPC_DIR ?? '/workspace/ipc'`.
- Derive `MESSAGES_DIR`, `TASKS_DIR`, `current_tasks.json`, `mcp_servers.json`, `_sent` sentinel from `IPC_DIR`.
- Export `writeIpcFile(dir, data)` and `resolveIpcDir(env)` for tests; keep the atomic temp-then-rename write.
- Context still from `NANOCLAW_CHAT_JID` / `NANOCLAW_GROUP_FOLDER` / `NANOCLAW_IS_MAIN`.
- Guard server startup (`server.connect`) behind `if (process.env.NANOCLAW_MCP_MAIN === 'stdio')` OR an `import.meta`-direct-run check so importing the module in tests does not open a stdio transport.

**Step 4: Run to verify pass**

Run: `npx vitest run src/nanoclaw-mcp-server.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/nanoclaw-mcp-server.ts src/nanoclaw-mcp-server.test.ts
git commit -m "feat: host-runnable nanoclaw MCP server (env-configurable IPC dir)"
```

---

## Task 2: `claude` stream-json parser (pure logic)

**Files:**
- Create: `src/claude-stream.ts`
- Create: `src/claude-stream.test.ts`

**Step 1: Write failing tests using the fixtures captured in Task 0**

```ts
import { describe, it, expect } from 'vitest';
import { ClaudeStreamParser } from './claude-stream.js';

const INIT = '<paste real init line from Task 0>';
const ASSISTANT = '<paste real assistant text line>';
const RESULT = '<paste real result line>';

describe('ClaudeStreamParser', () => {
  it('captures session id from the init event', () => {
    const p = new ClaudeStreamParser();
    p.push(INIT + '\n');
    expect(p.sessionId).toBeTruthy();
  });

  it('emits assistant text events', () => {
    const p = new ClaudeStreamParser();
    const texts: string[] = [];
    p.on('text', (t) => texts.push(t));
    p.push(ASSISTANT + '\n');
    expect(texts.join('')).toContain('HELLO');
  });

  it('handles a JSON object split across two chunks', () => {
    const p = new ClaudeStreamParser();
    const texts: string[] = [];
    p.on('text', (t) => texts.push(t));
    const half = Math.floor(ASSISTANT.length / 2);
    p.push(ASSISTANT.slice(0, half));
    p.push(ASSISTANT.slice(half) + '\n');
    expect(texts.join('')).toContain('HELLO');
  });

  it('marks completion on the result event', () => {
    const p = new ClaudeStreamParser();
    let done = false;
    p.on('result', () => { done = true; });
    p.push(RESULT + '\n');
    expect(done).toBe(true);
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run src/claude-stream.test.ts`
Expected: FAIL — `ClaudeStreamParser` not defined.

**Step 3: Implement the parser**

A small line-buffered parser (extends `EventEmitter`): accumulate chunks, split on `\n`, `JSON.parse` each complete line, and per the shapes recorded in Task 0:
- `system`/`init` → set `this.sessionId`.
- `assistant` → extract `message.content[].text`, emit `text`.
- `result` → capture final `session_id` (if it differs from init per Task 0 step 3) and emit `result`.
- Ignore unknown types; tolerate partial trailing lines across `push()` calls.

**Step 4: Run to verify pass**

Run: `npx vitest run src/claude-stream.test.ts`
Expected: PASS (all 4).

**Step 5: Commit**

```bash
git add src/claude-stream.ts src/claude-stream.test.ts
git commit -m "feat: line-buffered parser for claude stream-json output"
```

---

## Task 3: `host-claude-runner.ts`

Mirror `runContainerAgent`'s signature so callers swap with minimal change. Reuse the streaming/idle/timeout skeleton from `src/container-runner.ts`.

**Files:**
- Create: `src/host-claude-runner.ts`
- Create: `src/host-claude-runner.test.ts`
- Reference: `src/container-runner.ts` (skeleton), `src/config.ts` (timeouts/paths)

**Step 1: Write failing tests for argv construction**

Argv building is the pure, testable seam.
```ts
import { describe, it, expect } from 'vitest';
import { buildClaudeArgs } from './host-claude-runner.js';

describe('buildClaudeArgs', () => {
  it('uses print + stream-json + verbose', () => {
    const a = buildClaudeArgs({ prompt: 'hi' });
    expect(a).toContain('-p');
    expect(a.join(' ')).toContain('--output-format stream-json');
    expect(a).toContain('--verbose');
  });

  it('adds --resume only when a sessionId is provided', () => {
    expect(buildClaudeArgs({ prompt: 'hi' })).not.toContain('--resume');
    expect(buildClaudeArgs({ prompt: 'hi', sessionId: 'abc' })).toEqual(
      expect.arrayContaining(['--resume', 'abc']),
    );
  });

  it('passes the unattended permission flag verified in Task 0', () => {
    // assert against the exact flag recorded in scratch notes
    expect(buildClaudeArgs({ prompt: 'hi' }).join(' ')).toContain('<verified-flag>');
  });
});
```

**Step 2: Run to verify failure**

Run: `npx vitest run src/host-claude-runner.test.ts`
Expected: FAIL — `buildClaudeArgs` not defined.

**Step 3: Implement runner**

- `buildClaudeArgs({ prompt, sessionId })`: returns the flag array using the exact flags from Task 0 ground truth — `-p`, `--output-format stream-json`, `--verbose`, `--permission-mode bypassPermissions`, `--strict-mcp-config`, and `--resume <id>` only when a sessionId is present. Spawn with `cwd = path.join(GROUPS_DIR, 'main')`.
- `runHostClaudeAgent(group, input, onProcess, onOutput)`: same signature/return (`ContainerOutput`) as `runContainerAgent`. Spawn `claude` at its absolute path (`/Users/ballen/.local/bin/claude`; do not rely on launchd PATH — see MY-SETUP notes). Set env: inherit, plus **`CLAUDE_CONFIG_DIR=<abs>/data/sessions/main/.claude`** (the isolation requirement — without it the run inherits the user's personal `~/.claude`), `NANOCLAW_CHAT_JID`, `NANOCLAW_GROUP_FOLDER`, `NANOCLAW_IS_MAIN`, and `NANOCLAW_IPC_DIR=<abs>/data/ipc/main`. The isolated config dir is pre-authenticated (Task 1b), so no token injection is needed; if the dir is ever unauthenticated the run fails fast with "Not logged in".
- Pipe stdout through `ClaudeStreamParser`; on `text` build a `ContainerOutput {status:'success', result:text}` and call `onOutput`; capture `sessionId` into `newSessionId`. Reuse container-runner's idle-timer reset on activity, hard timeout (`Math.max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30_000)`), stdout/stderr size caps, and per-run log file under `groups/main/logs/`.
- **Carried forward from Task 1 review (must do):** before spawning, create the host IPC dirs mirroring `container-runner.ts:201-204` — `data/ipc/main/{messages,tasks,input,images}` — because the `nanoclaw` MCP `send_message` writes a `<IPC_DIR>/input/_sent` sentinel and will throw `ENOENT` if `input/` is absent. Also replicate the `_sent` sentinel consume/cleanup that the container agent-runner does (`container/agent-runner/src/index.ts` `checkAndClearSentFlag`), so the "did the agent message this turn" signal works on the host path (the host has no agent-runner). If that signal is unused by the host flow, explicitly note it; do not silently drop it.
- On close: resolve `{status, result:null, newSessionId}` mirroring container-runner's streaming-mode branch.

**Step 4: Run to verify pass**

Run: `npx vitest run src/host-claude-runner.test.ts`
Expected: PASS.

**Step 5: Integration verify (real `claude`)**

Write a throwaway `scripts/try-host-runner.ts` that calls `runHostClaudeAgent` with a fixed group object for `main` and prompt "Reply with READY", logging each `onOutput`. Run with `npx tsx scripts/try-host-runner.ts` and confirm "READY" streams back and a session id is captured. Delete the script; do not commit it.

**Step 6: Commit**

```bash
git add src/host-claude-runner.ts src/host-claude-runner.test.ts
git commit -m "feat: host-claude-runner — spawn claude headlessly for the main path"
```

---

## Task 4: `.claude/` config for `groups/main` (skills, MCP, hooks)

**Files:**
- Create: `groups/main/.mcp.json`
- Create/Modify: `groups/main/.claude/settings.json`
- Create: `groups/main/.claude/hooks/archive-precompact.mjs`
- Create: `groups/main/.claude/hooks/sanitize-bash.mjs`

**Step 1: Register the nanoclaw MCP server**

`groups/main/.mcp.json`:
```json
{
  "mcpServers": {
    "nanoclaw": {
      "command": "node",
      "args": ["<abs path>/dist/nanoclaw-mcp-server.js"],
      "env": {
        "NANOCLAW_MCP_MAIN": "stdio",
        "NANOCLAW_IPC_DIR": "<abs path>/data/ipc/main",
        "NANOCLAW_CHAT_JID": "<main chat jid>",
        "NANOCLAW_GROUP_FOLDER": "main",
        "NANOCLAW_IS_MAIN": "1"
      }
    }
  }
}
```
(The runner also sets these in the spawn env; `.mcp.json` covers the Remote Control process which the runner does not spawn. Resolve the JID from the registered main group — Task 6 of design references `db.ts`.)

**Step 2: Port the two SDK hooks to Claude Code command hooks**

The SDK ran two hooks in `agent-runner/src/index.ts`. Re-create as standalone scripts invoked via `settings.json` `hooks`:
- `sanitize-bash.mjs` — PreToolUse(Bash): read hook JSON from stdin, prepend `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null; ` to the command, emit the `updatedInput` hook output.
- `archive-precompact.mjs` — PreCompact: port `parseTranscript`/`formatTranscriptMarkdown`/`getSessionSummary` from `agent-runner/src/index.ts`, writing to `groups/main/conversations/`.

`groups/main/.claude/settings.json` (merge with the env block written by `container-runner.ts:160` if reused):
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1"
  },
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node <abs>/groups/main/.claude/hooks/sanitize-bash.mjs" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "node <abs>/groups/main/.claude/hooks/archive-precompact.mjs" }] }]
  }
}
```

**Step 3: Verify hooks load**

Run: `cd groups/main && claude -p "run: echo \$ANTHROPIC_API_KEY" --output-format stream-json --verbose 2>/dev/null | tail -5`
Expected: empty/unset value in output, proving the sanitize hook fired. Confirm no startup errors about the `nanoclaw` MCP server.

**Step 4: Commit**

```bash
git add groups/main/.mcp.json groups/main/.claude/settings.json groups/main/.claude/hooks/
git commit -m "feat: groups/main .claude config — nanoclaw MCP + ported hooks"
```

---

## Task 5: Route the main path through the host runner

**Files:**
- Modify: `src/index.ts` (`runAgent`, ~line 225-310)
- Modify: `src/task-scheduler.ts` (runner call site)

**Step 1: Failing test — runner selection by group**

Add `src/runner-selection.test.ts` asserting a small helper `chooseRunner(group)` returns the host runner for `folder === 'main'` and the container runner otherwise. (Extract `chooseRunner` so it is unit-testable without spawning.)

**Step 2: Run to verify failure**

Run: `npx vitest run src/runner-selection.test.ts` → FAIL.

**Step 3: Implement selection + wire in**

- Add `chooseRunner(group)` returning `runHostClaudeAgent` when `group.folder === MAIN_GROUP_FOLDER`, else `runContainerAgent`.
- In `runAgent` (`src/index.ts`), call `chooseRunner(group)` instead of `runContainerAgent` directly. The snapshot writes (`writeTasksSnapshot`, `writeGroupsSnapshot`, `writeMcpServersSnapshot`) stay — the host MCP reads the same `current_tasks.json`/`available_groups.json`/`mcp_servers.json` from `data/ipc/main/`.
- Mirror the same swap in `src/task-scheduler.ts`.
- The existing `GroupQueue` already serializes per-group work — confirm the host runner registers its child process via the same `onProcess(proc, name)` callback so queue shutdown/kill still works.

**Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS except the 6 known pre-existing `formatting.test.ts` failures (hardcoded `@Andy` vs `ASSISTANT_NAME=Taskie`). Confirm no NEW failures.

**Step 5: End-to-end verify via Telegram**

Build (`npm run build`), restart the service (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`), tail `logs/nanoclaw.log`. Send `@Taskie ping` from Telegram. Confirm: host `claude` spawned (no `container run` for main), reply delivered, session id persisted in SQLite (`getAllSessions`). Paste the relevant log lines.

**Step 6: Commit**

```bash
git add src/index.ts src/task-scheduler.ts src/runner-selection.test.ts
git commit -m "feat: route main group through host claude runner (container kept for others)"
```

---

## Task 6: Remote Control process (phone path)

**Files:**
- Create: `~/Library/LaunchAgents/com.nanoclaw.remote.plist`
- Modify: `docs/MY-SETUP.md`

**Step 1: Manual smoke test first**

```bash
cd groups/main && CLAUDE_CONFIG_DIR="$(git rev-parse --show-toplevel)/data/sessions/main/.claude" claude remote-control --name Taskie
```
Attach from the Claude mobile app — it should appear as a **"Taskie"** endpoint, separate from your personal Claude Code. Verify: Taskie's skills load (NOT superpowers), the `nanoclaw` MCP tools are available (try `send_message` → message arrives in Telegram), and `groups/main/CLAUDE.md` memory is in context. Confirm personal MCP/superpowers are absent (proves isolation). Record exact connect steps/URL behavior.

**Step 2: Create the launchd plist**

A `com.nanoclaw.remote` LaunchAgent: `WorkingDirectory` = `<abs>/groups/main`, `ProgramArguments` = absolute `claude` path + `remote-control --name Taskie` (+ any keep-alive flags discovered in Step 1), `EnvironmentVariables` including **`CLAUDE_CONFIG_DIR=<abs>/data/sessions/main/.claude`** (isolation) and a `PATH` with the Homebrew/node bin dir, `KeepAlive` true, `StandardOut/ErrorPath` to `logs/remote-control.log`.

**Step 3: Load and verify**

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.remote.plist
tail -f logs/remote-control.log
```
Confirm it stays running and is reachable from the phone after a fresh launch. Confirm the orchestrator (Telegram path) and remote-control run concurrently without the workspace corrupting — `GroupQueue` serialization (Task 5) plus low single-user frequency should hold; note any contention seen.

**Step 4: Document & commit**

Add a "Remote Control" section to `docs/MY-SETUP.md` (how to start/attach, the two-process model). Copy the plist into the repo at `launchd/com.nanoclaw.remote.plist` for version control.
```bash
git add launchd/com.nanoclaw.remote.plist docs/MY-SETUP.md
git commit -m "feat: launchd-managed claude remote-control for the phone path"
```

---

## Task 7: Retire the container path for main & document

**Files:**
- Modify: `src/container-runner.ts` (only if main-specific branches are now dead)
- Modify: `CLAUDE.md`, `docs/MY-SETUP.md`, `docs/REQUIREMENTS.md`
- Delete: `docs/plans/scratch-claude-cli-notes.md`

**Step 1: Remove now-dead main-only wiring**

Audit `container-runner.ts`'s `buildVolumeMounts` `isMain` branch and any main-only mounts/snapshots that the host path no longer uses. Remove only what is provably unused for non-main groups (which still use this file). Do NOT delete `container-runner.ts` or `container/agent-runner` — non-main groups depend on them.

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: only the 6 known pre-existing failures; no new ones.

**Step 3: Update docs**

- `CLAUDE.md`: update the Key Files table + Quick Context — main runs on the host harness; container is non-main + (future) browser sandbox.
- `docs/MY-SETUP.md`: the two-driver model, sandboxing note, browser-automation follow-up.
- `docs/REQUIREMENTS.md`: note the host-harness deviation from "everything in a container" for the main path and why (Remote Control, reliability).
- Add a memory pointer if appropriate (per the memory instructions).

**Step 4: Commit**

```bash
git rm docs/plans/scratch-claude-cli-notes.md
git add CLAUDE.md docs/MY-SETUP.md docs/REQUIREMENTS.md src/container-runner.ts
git commit -m "docs+chore: document host-harness model, retire dead main container wiring"
```

---

## Follow-ups (out of scope for this plan)

- Re-home `agent-browser`/Chromium off the Linux container for the host path (macOS Chromium, or an on-demand browser-only container).
- Optionally migrate non-main groups to the host model (currently retained on the container for stronger isolation).
- Tighten the macOS sandbox profile / allowed-dirs once the exact `claude` sandbox configuration is confirmed in Task 0.

## Definition of done

- `@Taskie` messages on Telegram are handled by a host-run `claude` (no container spawn for main), with replies delivered and sessions persisted.
- The phone (Remote Control) drives the same workspace/tools/memory; `send_message` from the phone reaches Telegram.
- Scheduled tasks for main run via the host runner.
- Non-main groups still work via the container path.
- Full vitest suite shows only the 6 known pre-existing failures.
