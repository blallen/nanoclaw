# che-ical-mcp Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `mcp-server-apple-events` (fragile, requires manual Swift compilation) with the precompiled `che-ical-mcp` binary, vendored at a pinned version.

**Architecture:** Download the `CheICalMCP` precompiled binary from GitHub Releases and commit it to `vendor/`. Update `McpBridge` to invoke it directly as the `--stdio` argument to supergateway. Remove `mcp-server-apple-events` from `package.json`. The rest of the bridge stack (supergateway, Streamable HTTP, mcp-remote in container) is unchanged.

**Tech Stack:** Swift precompiled binary (no compilation), supergateway (stdio→HTTP), Node.js/TypeScript, jj for commits.

---

### Task 1: Download and vendor the CheICalMCP binary

**Files:**
- Create: `vendor/CheICalMCP`
- Create: `vendor/.gitkeep` (to ensure vendor/ is tracked even if binary is gitignored)

**Step 1: Create the vendor directory**

```bash
mkdir -p vendor
```

**Step 2: Download the pinned binary**

```bash
curl -L https://github.com/kiki830621/che-ical-mcp/releases/download/v1.1.0/CheICalMCP \
  -o vendor/CheICalMCP
chmod +x vendor/CheICalMCP
```

**Step 3: Verify it runs**

```bash
vendor/CheICalMCP --help 2>&1 | head -5
```

Expected: some usage/version output (not "permission denied" or "not found").

**Step 4: Check it isn't gitignored**

```bash
git check-ignore -v vendor/CheICalMCP
```

Expected: no output (file is NOT ignored). If it is ignored, add `!vendor/CheICalMCP` to `.gitignore`.

**Step 5: Add a version marker file**

Create `vendor/VERSIONS.md`:

```markdown
# Vendored Binaries

| Binary | Version | Source |
|--------|---------|--------|
| CheICalMCP | v1.1.0 | https://github.com/kiki830621/che-ical-mcp/releases/tag/v1.1.0 |

## Updating

```bash
curl -L https://github.com/kiki830621/che-ical-mcp/releases/download/vX.Y.Z/CheICalMCP \
  -o vendor/CheICalMCP
chmod +x vendor/CheICalMCP
# Test, then update version in this file and commit
```
```

**Step 6: Commit**

```bash
jj describe -m "chore: vendor CheICalMCP v1.1.0 binary"
jj new
```

---

### Task 2: Update `src/mcp-bridge.ts`

**Files:**
- Modify: `src/mcp-bridge.ts`

**Step 1: Read the current file**

```bash
cat src/mcp-bridge.ts
```

**Step 2: Replace the implementation**

Replace the entire file with:

```typescript
import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { logger } from './logger.js';

// supergateway wraps the stdio MCP server as Streamable HTTP.
// Run it via the known node binary to avoid shebang failures under launchd's minimal PATH.
// CheICalMCP is a precompiled Swift binary vendored at vendor/CheICalMCP.
// To update: download new binary from https://github.com/kiki830621/che-ical-mcp/releases
// and update vendor/VERSIONS.md.
const supergatewayScript = join(process.cwd(), 'node_modules', 'supergateway', 'dist', 'index.js');
const cheICalMcpBinary = join(process.cwd(), 'vendor', 'CheICalMCP');

export class McpBridge {
  private proc: ChildProcess | null = null;
  private readonly port: number;
  private restartDelay = 1000;
  private stopping = false;

  constructor(port: number) {
    this.port = port;
  }

  start(): void {
    this.stopping = false;
    this.spawnProcess();
  }

  private spawnProcess(): void {
    this.proc = spawn(
      process.execPath,
      [supergatewayScript, '--stdio', cheICalMcpBinary, '--port', String(this.port), '--outputTransport', 'streamableHttp'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this.proc.stdout?.on('data', (d: Buffer) =>
      logger.debug({ bridge: 'apple-events' }, d.toString().trim()),
    );
    this.proc.stderr?.on('data', (d: Buffer) =>
      logger.debug({ bridge: 'apple-events' }, d.toString().trim()),
    );

    this.proc.on('exit', (code: number | null) => {
      if (this.stopping) return;
      logger.warn({ code, retryIn: this.restartDelay }, 'MCP bridge exited unexpectedly, restarting');
      setTimeout(() => {
        this.restartDelay = Math.min(this.restartDelay * 2, 30000);
        this.spawnProcess();
      }, this.restartDelay);
    });

    logger.info({ port: this.port }, 'MCP bridge started (apple-events)');
  }

  stop(): void {
    this.stopping = true;
    this.proc?.kill();
    this.proc = null;
    logger.info('MCP bridge stopped');
  }

  isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }
}
```

**Step 3: Typecheck**

```bash
node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Expected: no errors.

**Step 4: Commit**

```bash
jj describe -m "feat: switch MCP bridge to vendored CheICalMCP binary"
jj new
```

---

### Task 3: Remove `mcp-server-apple-events` from dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (auto-updated)

**Step 1: Uninstall the package**

```bash
npm uninstall mcp-server-apple-events --ignore-scripts
```

**Step 2: Verify it's gone**

```bash
grep "mcp-server-apple-events" package.json
```

Expected: no output.

**Step 3: Verify node_modules cleaned up**

```bash
ls node_modules/mcp-server-apple-events 2>&1
```

Expected: `No such file or directory`.

**Step 4: Commit**

```bash
jj describe -m "chore: remove mcp-server-apple-events dependency"
jj new
```

---

### Task 4: Update tool names in `groups/main/CLAUDE.md`

`che-ical-mcp` has different tool names than `mcp-server-apple-events`. Update the docs so Taskie knows what to call.

**Files:**
- Modify: `groups/main/CLAUDE.md`

**Step 1: Replace the Apple Reminders & Calendar section**

Find the `## Apple Reminders & Calendar` section and replace its tool listings with:

```markdown
## Apple Reminders & Calendar

You have access to Apple Reminders and Calendar via the `mcp__apple-events__*` tools.

**Reminders:**
- `mcp__apple-events__list_reminders` — list reminders (filter by list, due date, search term)
- `mcp__apple-events__create_reminder` — create a reminder with title, notes, due date, list
- `mcp__apple-events__update_reminder` — update an existing reminder
- `mcp__apple-events__complete_reminder` — mark a reminder complete
- `mcp__apple-events__delete_reminder` — delete a reminder
- `mcp__apple-events__search_reminders` — search reminders by keyword
- `mcp__apple-events__create_reminders_batch` — create multiple reminders at once
- `mcp__apple-events__delete_reminders_batch` — delete multiple reminders at once

**Calendar:**
- `mcp__apple-events__list_calendars` — list all calendars
- `mcp__apple-events__list_events` — get events in a date range
- `mcp__apple-events__create_event` — create a calendar event
- `mcp__apple-events__update_event` — update an existing event
- `mcp__apple-events__delete_event` — delete an event
- `mcp__apple-events__search_events` — search events by keyword
- `mcp__apple-events__check_conflicts` — check for scheduling conflicts
- `mcp__apple-events__create_events_batch` — create multiple events at once

Use these tools proactively when users ask about tasks, to-dos, schedules, or appointments. Prefer Reminders for tasks/to-dos and Calendar for time-bound events.
```

**Step 2: Commit**

```bash
jj describe -m "docs: update apple-events tool names for che-ical-mcp"
jj new
```

---

### Task 5: Build, restart, grant TCC permissions, and test

**Step 1: Build**

```bash
node_modules/.bin/tsc -p tsconfig.json
```

Expected: no errors, `dist/` updated.

**Step 2: Restart the service**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 8
tail -10 logs/nanoclaw.log
```

Expected: see `MCP bridge started (apple-events)` and no crash (`MCP bridge exited unexpectedly`) lines.

**Step 3: Verify bridge is listening**

```bash
lsof -i :7891 | head -3
```

Expected: a `node` process in LISTEN state.

**Step 4: Grant Reminders TCC permission**

On first run, CheICalMCP needs macOS to grant Reminders access. Trigger it:

```bash
curl -s --max-time 20 http://localhost:7891/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_reminders","arguments":{}}}' 2>&1
```

**Watch your Mac Mini screen** — a dialog saying "CheICalMCP wants to access your Reminders" should appear. Click **OK**.

If no dialog appears, check System Settings → Privacy & Security → Reminders for a denied entry and enable it manually.

**Step 5: Verify Reminders work**

Re-run the curl from Step 4. Expected: a JSON response listing your reminders (not "System error occurred").

**Step 6: Grant Calendar TCC permission**

```bash
curl -s --max-time 20 http://localhost:7891/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_calendars","arguments":{}}}' 2>&1
```

Expected: dialog for Calendar access, then a JSON list of your calendars.

**Step 7: Commit**

```bash
jj describe -m "chore: rebuild after che-ical-mcp migration"
jj new
```

**Step 8: Push all commits**

```bash
jj bookmark set main -r @-
jj git push --remote origin --bookmark main
```

**Step 9: Send Taskie a test message**

In Telegram, send: `@Taskie What are my reminders?`

Expected: Taskie calls `mcp__apple-events__list_reminders` and lists your actual reminders.
