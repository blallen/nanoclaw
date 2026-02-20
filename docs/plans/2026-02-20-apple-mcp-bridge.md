# Apple Reminders & Calendar MCP Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bridge `mcp-server-apple-events` (runs on host macOS) into the NanoClaw Linux container agent so Taskie can read and write Apple Reminders and Calendar events.

**Architecture:** NanoClaw spawns `supergateway` on the host to expose `mcp-server-apple-events` over HTTP/SSE on port 7891. When spawning a container, NanoClaw discovers the VM's host gateway IP and passes it as `NANOCLAW_MCP_HOST`. The container agent uses `mcp-remote` to connect back to the host bridge.

**Tech Stack:** `supergateway` (npx, host-side stdio→HTTP/SSE), `mcp-remote` (npx, container-side MCP client), `mcp-server-apple-events` (npx, macOS APIs), TypeScript.

---

### Task 1: Add `mcp-remote` to the container agent

`mcp-remote` is the client the container uses to connect to the host bridge. Install it into the container image so it's available without downloading at runtime.

**Files:**
- Modify: `container/agent-runner/package.json`

**Step 1: Add the dependency**

In `container/agent-runner/package.json`, add to `dependencies`:
```json
"mcp-remote": "latest"
```

**Step 2: Verify it installs cleanly**

```bash
cd container/agent-runner && npm install
```
Expected: no errors, `mcp-remote` appears in `node_modules`.

**Step 3: Commit**

```bash
jj describe -m "feat: add mcp-remote to container agent dependencies"
```

---

### Task 2: Add MCP bridge config to `src/config.ts`

**Files:**
- Modify: `src/config.ts`

**Step 1: Update `readEnvFile` call to include new keys**

Find this line (around line 8):
```typescript
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ONLY']);
```
Replace with:
```typescript
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ONLY', 'MCP_BRIDGE_PORT', 'MCP_BRIDGE_ENABLED', 'MCP_BRIDGE_HOST']);
```

**Step 2: Add the exports**

Add these after the `TELEGRAM_ONLY` export (around line 17):
```typescript
export const MCP_BRIDGE_PORT = parseInt(
  process.env.MCP_BRIDGE_PORT || envConfig.MCP_BRIDGE_PORT || '7891',
  10,
);
export const MCP_BRIDGE_ENABLED =
  (process.env.MCP_BRIDGE_ENABLED || envConfig.MCP_BRIDGE_ENABLED || 'true') !== 'false';
export const MCP_BRIDGE_HOST =
  process.env.MCP_BRIDGE_HOST || envConfig.MCP_BRIDGE_HOST || '';
```

**Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

**Step 4: Commit**

```bash
jj describe -m "feat: add MCP bridge config (port, enabled, host override)"
```

---

### Task 3: Create `src/mcp-bridge.ts`

**Files:**
- Create: `src/mcp-bridge.ts`

**Step 1: Create the file**

```typescript
import { spawn, ChildProcess } from 'child_process';
import { logger } from './logger.js';

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
      'npx',
      ['-y', 'supergateway', '--stdio', 'npx -y mcp-server-apple-events', '--port', String(this.port)],
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

**Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

**Step 3: Commit**

```bash
jj describe -m "feat: add McpBridge class for host-side apple-events MCP server"
```

---

### Task 4: Add host gateway IP discovery to `src/container-runner.ts`

The container needs to know the host's IP to reach the bridge. Discover it by running a lightweight container and reading its default route.

**Files:**
- Modify: `src/container-runner.ts`

**Step 1: Add the import and cached variable**

At the top of the file, `execSync` is already imported. Add after the existing imports:
```typescript
import { MCP_BRIDGE_HOST, MCP_BRIDGE_PORT } from './config.js';
```

Add this near the top of the module (after imports, before functions):
```typescript
let cachedHostGateway: string | null | undefined = undefined;
```

**Step 2: Add the discovery function**

Add this function before `buildVolumeMounts`:
```typescript
/**
 * Discover the host gateway IP reachable from inside Apple Container VMs.
 * Runs a lightweight container to read its default route.
 * Result is cached for the process lifetime.
 */
export async function discoverHostGateway(): Promise<string | null> {
  if (cachedHostGateway !== undefined) return cachedHostGateway;

  // Manual override takes priority
  if (MCP_BRIDGE_HOST) {
    cachedHostGateway = MCP_BRIDGE_HOST;
    logger.info({ ip: cachedHostGateway }, 'Using MCP_BRIDGE_HOST override for host gateway');
    return cachedHostGateway;
  }

  try {
    const output = execSync(
      'container run --rm alpine ip route show default',
      { encoding: 'utf-8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const match = output.match(/default via (\S+)/);
    cachedHostGateway = match?.[1] ?? null;
  } catch (err) {
    logger.warn({ err }, 'Failed to discover host gateway IP');
    cachedHostGateway = null;
  }

  if (cachedHostGateway) {
    logger.info({ ip: cachedHostGateway }, 'Discovered host gateway IP for MCP bridge');
  } else {
    logger.warn('Could not discover host gateway IP; apple-events MCP will be unavailable');
  }
  return cachedHostGateway;
}
```

**Step 3: Pass host IP into `buildContainerArgs`**

Update the `buildContainerArgs` signature to accept an optional host IP:
```typescript
function buildContainerArgs(mounts: VolumeMount[], containerName: string, hostIp?: string | null): string[] {
```

Add these lines just before `args.push(CONTAINER_IMAGE)` at the end of `buildContainerArgs`:
```typescript
  if (hostIp) {
    args.push('-e', `NANOCLAW_MCP_HOST=${hostIp}`);
    args.push('-e', `NANOCLAW_MCP_PORT=${MCP_BRIDGE_PORT}`);
  }
```

**Step 4: Call discovery in `runContainerAgent`**

In `runContainerAgent`, find:
```typescript
  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);
```

Replace with:
```typescript
  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const hostIp = await discoverHostGateway();
  const containerArgs = buildContainerArgs(mounts, containerName, hostIp);
```

**Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

**Step 6: Commit**

```bash
jj describe -m "feat: discover host gateway IP and inject into container environment"
```

---

### Task 5: Wire `McpBridge` into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Step 1: Add imports**

Add to the existing imports near the top:
```typescript
import { McpBridge } from './mcp-bridge.js';
import { MCP_BRIDGE_ENABLED, MCP_BRIDGE_PORT } from './config.js';
```

**Step 2: Declare the bridge instance**

Add alongside the existing channel declarations (near `let whatsapp: WhatsAppChannel`):
```typescript
let mcpBridge: McpBridge | null = null;
```

**Step 3: Start the bridge in `main()`**

In `main()`, add this block just before the channel creation block (`if (!TELEGRAM_ONLY)`):
```typescript
  // Start host-side MCP bridge for Apple Reminders/Calendar
  if (MCP_BRIDGE_ENABLED) {
    mcpBridge = new McpBridge(MCP_BRIDGE_PORT);
    mcpBridge.start();
  }
```

**Step 4: Stop the bridge in shutdown**

In the `shutdown` handler, add `mcpBridge?.stop()` before `process.exit(0)`:
```typescript
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    mcpBridge?.stop();
    process.exit(0);
  };
```

**Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

**Step 6: Commit**

```bash
jj describe -m "feat: start/stop McpBridge alongside channels in main lifecycle"
```

---

### Task 6: Add `apple-events` MCP server to the container agent

**Files:**
- Modify: `container/agent-runner/src/index.ts`

**Step 1: Add `apple-events` to `allowedTools`**

Find the `allowedTools` array (around line 426). Add `'mcp__apple-events__*'` to the list:
```typescript
allowedTools: [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__apple-events__*',
],
```

**Step 2: Add the MCP server config**

Find the `mcpServers` block (around line 440):
```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
},
```

Replace with:
```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
  ...(process.env.NANOCLAW_MCP_HOST ? {
    'apple-events': {
      command: 'npx',
      args: [
        'mcp-remote',
        `http://${process.env.NANOCLAW_MCP_HOST}:${process.env.NANOCLAW_MCP_PORT || '7891'}/sse`,
      ],
    },
  } : {}),
},
```

**Step 3: Typecheck the agent runner**

```bash
cd container/agent-runner && npx tsc --noEmit
```
Expected: no errors.

**Step 4: Commit**

```bash
jj describe -m "feat: add apple-events MCP server to container agent via mcp-remote"
```

---

### Task 7: Document tools in `groups/main/CLAUDE.md`

**Files:**
- Modify: `groups/main/CLAUDE.md`

**Step 1: Add a Reminders & Calendar section**

Add this section after "## What You Can Do" (insert before the `## Communication` heading):

```markdown
## Apple Reminders & Calendar

You have access to Apple Reminders and Calendar via the `mcp__apple-events__*` tools.

**Reminders:**
- `mcp__apple-events__get-lists` — list all Reminders lists
- `mcp__apple-events__get-reminders` — get reminders from a list (optionally filter incomplete only)
- `mcp__apple-events__create-reminder` — create a reminder with title, notes, due date, priority
- `mcp__apple-events__update-reminder` — update an existing reminder
- `mcp__apple-events__complete-reminder` — mark a reminder complete

**Calendar:**
- `mcp__apple-events__get-calendars` — list all calendars
- `mcp__apple-events__get-events` — get events in a date range
- `mcp__apple-events__create-event` — create a calendar event
- `mcp__apple-events__update-event` — update an existing event
- `mcp__apple-events__delete-event` — delete an event

Use these tools proactively when users ask about tasks, to-dos, schedules, or appointments. Prefer Reminders for tasks/to-dos and Calendar for time-bound events.
```

**Step 2: Commit**

```bash
jj describe -m "docs: document Apple Reminders and Calendar MCP tools for Taskie"
```

---

### Task 8: Build, rebuild container, and restart

**Step 1: Build the host TypeScript**

```bash
npm run build
```
Expected: no errors.

**Step 2: Rebuild the container image**

The container agent source is mounted from the host at runtime (see `buildVolumeMounts`), so a full container rebuild is not required for `container/agent-runner/src/` changes. However, `container/agent-runner/package.json` changed (added `mcp-remote`), which requires a rebuild:

```bash
./container/build.sh
```
Expected: build completes, `nanoclaw-agent:latest` updated.

**Step 3: Restart the service**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Step 4: Verify bridge started**

```bash
tail -20 logs/nanoclaw.log
```
Expected: see `MCP bridge started (apple-events)` and `Discovered host gateway IP for MCP bridge` lines.

---

### Task 9: Integration test

**Step 1: Send a Reminders test message to Taskie**

In your Telegram DM with Taskie, send:
> "Add a reminder to test the Apple Reminders integration"

Expected: Taskie creates a reminder in Apple Reminders and confirms it.

**Step 2: Grant macOS permissions if prompted**

A dialog saying **"node wants to access your Reminders"** will appear — click **OK**. Repeat for Calendar if prompted.

**Step 3: Verify in Apple Reminders**

Open Reminders on your Mac and confirm the test reminder was created.

**Step 4: Test Calendar**

Send: "What's on my calendar tomorrow?"

Expected: Taskie reads your calendar events and lists them.

**Step 5: Push to remote**

```bash
jj git push --remote origin --bookmark main
```
