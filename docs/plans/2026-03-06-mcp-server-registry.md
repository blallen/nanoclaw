# MCP Server Registry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the single MCP bridge with a multi-port bridge manager that agents can control via IPC tools — adding, removing, restarting, and patching MCP servers.

**Architecture:** A `McpBridgeManager` reads `mcp-servers/registry.json`, spawns one supergateway per stdio server (or passes through HTTP URLs), watches for file changes, and exposes management via IPC. The container agent reads an `mcp_servers.json` snapshot to configure mcp-remote connections dynamically.

**Tech Stack:** Node.js, TypeScript, vitest, fs.watch, supergateway, mcp-remote

---

### Task 1: Registry file and types

**Files:**
- Create: `mcp-servers/registry.json`
- Create: `src/mcp-registry.ts`

**Step 1: Create the registry JSON**

```json
{
  "servers": {
    "apple-events": {
      "transport": "stdio",
      "command": "node",
      "args": ["node_modules/mcp-server-apple-events/dist/index.js"],
      "port": 7891,
      "enabled": true
    }
  }
}
```

This mirrors the current `mcp-bridge.ts` setup — same server, same port.

**Step 2: Create the types and loader**

Create `src/mcp-registry.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface StdioServerConfig {
  transport: 'stdio';
  command: string;
  args: string[];
  port: number;
  enabled: boolean;
}

export interface HttpServerConfig {
  transport: 'http';
  url: string;
  enabled: boolean;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export interface Registry {
  servers: Record<string, ServerConfig>;
}

export function loadRegistry(registryPath: string): Registry {
  const content = fs.readFileSync(registryPath, 'utf-8');
  const registry: Registry = JSON.parse(content);

  // Validate: no duplicate ports
  const ports = new Map<number, string>();
  for (const [name, config] of Object.entries(registry.servers)) {
    if (config.transport === 'stdio') {
      const existing = ports.get(config.port);
      if (existing) {
        throw new Error(`Port ${config.port} used by both "${existing}" and "${name}"`);
      }
      ports.set(config.port, name);
    }
  }

  return registry;
}

export function saveRegistry(registryPath: string, registry: Registry): void {
  const tempPath = `${registryPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2) + '\n');
  fs.renameSync(tempPath, registryPath);
}

/**
 * Find the next available port starting from basePort.
 */
export function findNextPort(registry: Registry, basePort: number = 7891): number {
  const usedPorts = new Set<number>();
  for (const config of Object.values(registry.servers)) {
    if (config.transport === 'stdio') {
      usedPorts.add(config.port);
    }
  }
  let port = basePort;
  while (usedPorts.has(port)) port++;
  return port;
}
```

**Step 3: Run TypeScript compilation to verify**

Run: `npm run build`
Expected: No errors

**Step 4: Commit**

```
jj describe -m "feat: add MCP server registry types and loader"
jj new
```

---

### Task 2: McpBridgeManager — core lifecycle

**Files:**
- Create: `src/mcp-bridge-manager.ts`
- Test: `src/mcp-bridge-manager.test.ts`

**Step 1: Write the failing test**

Create `src/mcp-bridge-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpBridgeManager } from './mcp-bridge-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let registryPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  registryPath = path.join(tmpDir, 'registry.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('McpBridgeManager', () => {
  it('listServers returns servers from registry', () => {
    fs.writeFileSync(registryPath, JSON.stringify({
      servers: {
        'test-server': {
          transport: 'http',
          url: 'http://localhost:3000/mcp',
          enabled: true,
        },
      },
    }));

    const manager = new McpBridgeManager(registryPath);
    const servers = manager.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('test-server');
    expect(servers[0].enabled).toBe(true);
    expect(servers[0].running).toBe(false);
  });

  it('listServers returns empty for missing registry', () => {
    const manager = new McpBridgeManager(path.join(tmpDir, 'nonexistent.json'));
    const servers = manager.listServers();
    expect(servers).toHaveLength(0);
  });

  it('getServerUrls returns URLs for enabled servers', () => {
    fs.writeFileSync(registryPath, JSON.stringify({
      servers: {
        'http-server': {
          transport: 'http',
          url: 'http://localhost:3000/mcp',
          enabled: true,
        },
        'disabled-server': {
          transport: 'http',
          url: 'http://localhost:3001/mcp',
          enabled: false,
        },
      },
    }));

    const manager = new McpBridgeManager(registryPath);
    // HTTP servers are "running" immediately (no process to spawn)
    manager.start();
    const urls = manager.getServerUrls('192.168.64.1');
    expect(urls['http-server']).toEqual({ url: 'http://localhost:3000/mcp' });
    expect(urls['disabled-server']).toBeUndefined();
    manager.stopAll();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-bridge-manager.test.ts`
Expected: FAIL — module not found

**Step 3: Implement McpBridgeManager**

Create `src/mcp-bridge-manager.ts`:

```typescript
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { loadRegistry, Registry, ServerConfig, StdioServerConfig } from './mcp-registry.js';

interface BridgeProcess {
  proc: ChildProcess;
  config: StdioServerConfig;
  restartDelay: number;
  stopping: boolean;
}

export interface ServerStatus {
  name: string;
  transport: string;
  port?: number;
  url?: string;
  enabled: boolean;
  running: boolean;
}

export class McpBridgeManager {
  private bridges = new Map<string, BridgeProcess>();
  private httpServers = new Map<string, { url: string }>();
  private readonly registryPath: string;
  private readonly supergatewayScript: string;
  private fileWatcher: fs.FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopping = false;

  constructor(registryPath: string) {
    this.registryPath = registryPath;
    this.supergatewayScript = path.join(process.cwd(), 'node_modules', 'supergateway', 'dist', 'index.js');
  }

  start(): void {
    this.stopping = false;
    const registry = this.loadRegistrySafe();
    if (!registry) return;

    for (const [name, config] of Object.entries(registry.servers)) {
      if (!config.enabled) continue;

      if (config.transport === 'stdio') {
        this.startStdioServer(name, config);
      } else if (config.transport === 'http') {
        this.httpServers.set(name, { url: config.url });
        logger.info({ name, url: config.url }, 'Registered HTTP MCP server');
      }
    }

    this.startFileWatcher();
  }

  private startStdioServer(name: string, config: StdioServerConfig): void {
    // Resolve command path: if relative, resolve from project root
    const command = config.command === 'node' ? process.execPath : config.command;
    const args = [
      this.supergatewayScript,
      '--stdio',
      `${command} ${config.args.join(' ')}`,
      '--port',
      String(config.port),
      '--outputTransport',
      'streamableHttp',
    ];

    const proc = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const bridge: BridgeProcess = { proc, config, restartDelay: 1000, stopping: false };
    this.bridges.set(name, bridge);

    proc.stdout?.on('data', (d: Buffer) =>
      logger.debug({ bridge: name }, d.toString().trim()),
    );
    proc.stderr?.on('data', (d: Buffer) =>
      logger.debug({ bridge: name }, d.toString().trim()),
    );

    proc.on('exit', (code: number | null) => {
      if (bridge.stopping || this.stopping) return;
      logger.warn({ name, code, retryIn: bridge.restartDelay }, 'MCP bridge exited unexpectedly, restarting');
      setTimeout(() => {
        bridge.restartDelay = Math.min(bridge.restartDelay * 2, 30000);
        this.bridges.delete(name);
        this.startStdioServer(name, config);
      }, bridge.restartDelay);
    });

    logger.info({ name, port: config.port }, 'MCP bridge started');
  }

  stopServer(name: string): void {
    const bridge = this.bridges.get(name);
    if (bridge) {
      bridge.stopping = true;
      bridge.proc.kill();
      this.bridges.delete(name);
      logger.info({ name }, 'MCP bridge stopped');
    }
    this.httpServers.delete(name);
  }

  startServer(name: string): void {
    const registry = this.loadRegistrySafe();
    if (!registry) return;
    const config = registry.servers[name];
    if (!config || !config.enabled) return;

    if (config.transport === 'stdio') {
      this.startStdioServer(name, config);
    } else if (config.transport === 'http') {
      this.httpServers.set(name, { url: config.url });
    }
  }

  restartServer(name: string): void {
    this.stopServer(name);
    this.startServer(name);
  }

  stopAll(): void {
    this.stopping = true;
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();

    for (const [name, bridge] of this.bridges) {
      bridge.stopping = true;
      bridge.proc.kill();
      logger.info({ name }, 'MCP bridge stopped');
    }
    this.bridges.clear();
    this.httpServers.clear();
  }

  listServers(): ServerStatus[] {
    const registry = this.loadRegistrySafe();
    if (!registry) return [];

    return Object.entries(registry.servers).map(([name, config]) => ({
      name,
      transport: config.transport,
      port: config.transport === 'stdio' ? config.port : undefined,
      url: config.transport === 'http' ? config.url : undefined,
      enabled: config.enabled,
      running: this.bridges.has(name) || this.httpServers.has(name),
    }));
  }

  /**
   * Build URL map for container snapshot.
   * hostIp is the gateway IP containers use to reach the host.
   */
  getServerUrls(hostIp: string): Record<string, { url: string }> {
    const urls: Record<string, { url: string }> = {};

    for (const [name, bridge] of this.bridges) {
      urls[name] = { url: `http://${hostIp}:${bridge.config.port}/mcp` };
    }
    for (const [name, server] of this.httpServers) {
      urls[name] = { url: server.url };
    }

    return urls;
  }

  isAnyRunning(): boolean {
    return this.bridges.size > 0 || this.httpServers.size > 0;
  }

  private loadRegistrySafe(): Registry | null {
    try {
      return loadRegistry(this.registryPath);
    } catch (err) {
      logger.warn({ err, path: this.registryPath }, 'Failed to load MCP registry');
      return null;
    }
  }

  private startFileWatcher(): void {
    const watchDir = path.dirname(this.registryPath);
    if (!fs.existsSync(watchDir)) return;

    try {
      this.fileWatcher = fs.watch(watchDir, { recursive: true }, (event, filename) => {
        if (!filename) return;

        // Registry itself changed — full reconciliation
        if (filename === 'registry.json' || filename === path.basename(this.registryPath)) {
          this.debounce('__registry__', () => this.reconcile());
          return;
        }

        // Server code changed — restart just that server
        const serverName = filename.split(path.sep)[0];
        if (serverName && this.bridges.has(serverName)) {
          this.debounce(serverName, () => {
            logger.info({ name: serverName, filename }, 'Server file changed, restarting bridge');
            this.restartServer(serverName);
          });
        }
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to start MCP server file watcher');
    }
  }

  private debounce(key: string, fn: () => void, delayMs = 500): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, delayMs));
  }

  private reconcile(): void {
    logger.info('Registry changed, reconciling MCP bridges');
    const registry = this.loadRegistrySafe();
    if (!registry) return;

    const desired = new Set<string>();
    for (const [name, config] of Object.entries(registry.servers)) {
      if (!config.enabled) continue;
      desired.add(name);

      const isRunning = this.bridges.has(name) || this.httpServers.has(name);
      if (!isRunning) {
        this.startServer(name);
      }
    }

    // Stop servers that are no longer in registry or disabled
    for (const name of [...this.bridges.keys(), ...this.httpServers.keys()]) {
      if (!desired.has(name)) {
        this.stopServer(name);
      }
    }
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run src/mcp-bridge-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```
jj describe -m "feat: add McpBridgeManager with multi-server lifecycle"
jj new
```

---

### Task 3: Wire McpBridgeManager into index.ts

**Files:**
- Modify: `src/index.ts:17,59,475-493`
- Modify: `src/config.ts:18-25`

**Step 1: Update config.ts**

Remove `MCP_BRIDGE_PORT` (port is now per-server in registry). Keep `MCP_BRIDGE_ENABLED` and `MCP_BRIDGE_HOST`. Add registry path:

```typescript
// Replace MCP_BRIDGE_PORT with registry path
export const MCP_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'mcp-servers', 'registry.json');
```

**Step 2: Update index.ts imports and startup**

Replace `McpBridge` with `McpBridgeManager`:

```typescript
// Replace:
import { McpBridge } from './mcp-bridge.js';
// With:
import { McpBridgeManager } from './mcp-bridge-manager.js';
```

Change the `mcpBridge` variable:

```typescript
// Replace:
let mcpBridge: McpBridge | null = null;
// With:
let mcpBridgeManager: McpBridgeManager | null = null;
```

Update the startup block in `main()` (~line 489-493):

```typescript
// Replace:
if (MCP_BRIDGE_ENABLED) {
  mcpBridge = new McpBridge(MCP_BRIDGE_PORT);
  mcpBridge.start();
}
// With:
if (MCP_BRIDGE_ENABLED) {
  mcpBridgeManager = new McpBridgeManager(MCP_REGISTRY_PATH);
  mcpBridgeManager.start();
}
```

Update shutdown handler (~line 475):

```typescript
// Replace:
mcpBridge?.stop();
// With:
mcpBridgeManager?.stopAll();
```

**Step 3: Build and run existing tests**

Run: `npm run build && npx vitest run`
Expected: All existing tests pass. Build succeeds.

**Step 4: Commit**

```
jj describe -m "refactor: wire McpBridgeManager into main startup"
jj new
```

---

### Task 4: Update container-runner to write MCP server snapshot

**Files:**
- Modify: `src/container-runner.ts:10-11,231-254,246-249`
- Modify: `src/index.ts` (pass manager to runAgent)

**Step 1: Add writeMcpServersSnapshot function**

Add to `container-runner.ts`:

```typescript
/**
 * Write MCP servers snapshot for the container agent to read.
 * Maps server names to their URLs.
 */
export function writeMcpServersSnapshot(
  groupFolder: string,
  servers: Record<string, { url: string }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const serversFile = path.join(groupIpcDir, 'mcp_servers.json');
  fs.writeFileSync(serversFile, JSON.stringify({ servers }, null, 2));
}
```

**Step 2: Update buildContainerArgs to stop passing single MCP host/port env vars**

In `buildContainerArgs` (~line 231), replace the `hostIp` env var block:

```typescript
// Replace:
if (hostIp) {
  args.push('-e', `NANOCLAW_MCP_HOST=${hostIp}`);
  args.push('-e', `NANOCLAW_MCP_PORT=${MCP_BRIDGE_PORT}`);
}
// With:
if (hostIp) {
  args.push('-e', `NANOCLAW_MCP_HOST=${hostIp}`);
}
```

The host IP is still needed for the container to know where the host is, but individual server URLs come from the snapshot.

**Step 3: Update index.ts to write MCP server snapshot before agent runs**

In `runAgent()` (~line 232), after writing tasks snapshot, add:

```typescript
// Write MCP servers snapshot for container to read
if (mcpBridgeManager) {
  const hostIp = await discoverHostGateway();
  if (hostIp) {
    writeMcpServersSnapshot(group.folder, mcpBridgeManager.getServerUrls(hostIp));
  }
}
```

Import `writeMcpServersSnapshot` and `discoverHostGateway` at the top.

**Step 4: Build and run tests**

Run: `npm run build && npx vitest run`
Expected: All tests pass.

**Step 5: Commit**

```
jj describe -m "feat: write MCP servers snapshot for container agents"
jj new
```

---

### Task 5: Update agent runner to read MCP server snapshot

**Files:**
- Modify: `container/agent-runner/src/index.ts:416-461`

**Step 1: Add snapshot reader**

Add before `main()`:

```typescript
interface McpServersSnapshot {
  servers: Record<string, { url: string }>;
}

function loadMcpServers(): Record<string, { command: string; args: string[] }> {
  const snapshotPath = '/workspace/ipc/mcp_servers.json';
  const mcpServers: Record<string, { command: string; args: string[] }> = {};

  try {
    if (fs.existsSync(snapshotPath)) {
      const snapshot: McpServersSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      for (const [name, config] of Object.entries(snapshot.servers)) {
        mcpServers[name] = {
          command: 'npx',
          args: ['mcp-remote', config.url, '--allow-http'],
        };
      }
      log(`Loaded ${Object.keys(mcpServers).length} MCP servers from snapshot`);
    }
  } catch (err) {
    log(`Failed to load MCP servers snapshot: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fallback: if no snapshot but env vars set, use legacy single-server config
  if (Object.keys(mcpServers).length === 0 && process.env.NANOCLAW_MCP_HOST) {
    mcpServers['apple-events'] = {
      command: 'npx',
      args: [
        'mcp-remote',
        `http://${process.env.NANOCLAW_MCP_HOST}:${process.env.NANOCLAW_MCP_PORT || '7891'}/mcp`,
        '--allow-http',
      ],
    };
    log('Using legacy MCP config from env vars');
  }

  return mcpServers;
}
```

**Step 2: Update mcpServers in query options**

In `runQuery()`, replace the hardcoded `mcpServers` block (~lines 441-461):

```typescript
// Replace the entire mcpServers block with:
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
  ...loadMcpServers(),
},
```

**Step 3: Update allowedTools to wildcard all MCP servers**

Replace the hardcoded `'mcp__apple-events__*'` in allowedTools (~line 435):

```typescript
// Build allowedTools dynamically
const mcpServers = loadMcpServers();
const mcpWildcards = Object.keys(mcpServers).map(name => `mcp__${name}__*`);
```

Then in the `allowedTools` array, replace `'mcp__apple-events__*'` with `...mcpWildcards`.

Note: `loadMcpServers()` should be called once and stored, not called twice. Refactor so it's called once in `runQuery` and the result is reused for both `mcpServers` config and `allowedTools`.

**Step 4: Build agent runner to verify**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No type errors

**Step 5: Commit**

```
jj describe -m "feat: agent runner reads MCP servers from snapshot"
jj new
```

---

### Task 6: IPC tools for MCP server management (container side)

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

**Step 1: Add MCP management tools**

Add these tools after the existing `register_group` tool:

```typescript
server.tool(
  'list_mcp_servers',
  'List all registered MCP servers and their status (running/stopped/enabled/disabled).',
  {},
  async () => {
    const snapshotPath = '/workspace/ipc/mcp_servers.json';
    try {
      if (!fs.existsSync(snapshotPath)) {
        return { content: [{ type: 'text' as const, text: 'No MCP servers configured.' }] };
      }
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      const formatted = Object.entries(snapshot.servers)
        .map(([name, config]: [string, any]) => `- ${name}: ${config.url}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text: `MCP servers:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading MCP servers: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'add_mcp_server',
  `Add a new MCP server to the registry. The server will be started automatically.

Transport types:
- "stdio": A local process that speaks MCP over stdio. Requires command and args. A port will be auto-assigned.
- "http": An existing HTTP MCP server. Requires url.

Examples:
- stdio: add_mcp_server({name: "notes", transport: "stdio", command: "node", args: "mcp-servers/notes/dist/index.js"})
- http: add_mcp_server({name: "feedly", transport: "http", url: "http://localhost:3000/mcp"})`,
  {
    name: z.string().describe('Unique name for the server (lowercase, hyphens, e.g. "feedly")'),
    transport: z.enum(['stdio', 'http']).describe('stdio=local process, http=existing HTTP server'),
    command: z.string().optional().describe('(stdio only) Command to run the server'),
    args: z.string().optional().describe('(stdio only) Space-separated args for the command'),
    url: z.string().optional().describe('(http only) URL of the existing MCP server'),
  },
  async (params) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage MCP servers.' }], isError: true };
    }

    if (params.transport === 'stdio' && !params.command) {
      return { content: [{ type: 'text' as const, text: 'stdio transport requires command.' }], isError: true };
    }
    if (params.transport === 'http' && !params.url) {
      return { content: [{ type: 'text' as const, text: 'http transport requires url.' }], isError: true };
    }

    const data: Record<string, unknown> = {
      type: 'add_mcp_server',
      name: params.name,
      transport: params.transport,
      command: params.command,
      args: params.args ? params.args.split(' ') : [],
      url: params.url,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `MCP server "${params.name}" add requested. It will start automatically.` }],
    };
  },
);

server.tool(
  'remove_mcp_server',
  'Remove an MCP server from the registry. The server will be stopped.',
  {
    name: z.string().describe('Name of the server to remove'),
  },
  async (params) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage MCP servers.' }], isError: true };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'remove_mcp_server',
      name: params.name,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `MCP server "${params.name}" removal requested.` }],
    };
  },
);

server.tool(
  'restart_mcp_server',
  'Restart a specific MCP server bridge. Use after editing server code.',
  {
    name: z.string().describe('Name of the server to restart'),
  },
  async (params) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage MCP servers.' }], isError: true };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'restart_mcp_server',
      name: params.name,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `MCP server "${params.name}" restart requested.` }],
    };
  },
);

server.tool(
  'restart_all_mcp_servers',
  'Re-read the registry and reconcile all MCP server bridges. Use after editing registry.json directly.',
  {},
  async () => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage MCP servers.' }], isError: true };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'restart_all_mcp_servers',
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: 'Full MCP server reconciliation requested.' }],
    };
  },
);
```

**Step 2: Build agent runner**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No type errors

**Step 3: Commit**

```
jj describe -m "feat: add MCP server management IPC tools"
jj new
```

---

### Task 7: IPC handler for MCP server management (host side)

**Files:**
- Modify: `src/ipc.ts:17-29,154-176,179`
- Test: `src/ipc-auth.test.ts` (add new tests)

**Step 1: Write failing tests**

Add to `src/ipc-auth.test.ts`:

```typescript
// --- MCP server management authorization ---

describe('MCP server management authorization', () => {
  it('main group can add an MCP server', async () => {
    const mcpOps: Array<{ type: string; name: string }> = [];
    const mcpDeps = {
      ...deps,
      addMcpServer: async (name: string, config: any) => { mcpOps.push({ type: 'add', name }); },
      removeMcpServer: async (name: string) => { mcpOps.push({ type: 'remove', name }); },
      restartMcpServer: async (name: string) => { mcpOps.push({ type: 'restart', name }); },
      restartAllMcpServers: async () => { mcpOps.push({ type: 'restart_all', name: '*' }); },
    };

    await processTaskIpc(
      {
        type: 'add_mcp_server',
        name: 'test-server',
        transport: 'http',
        url: 'http://localhost:3000/mcp',
      },
      'main',
      true,
      mcpDeps,
    );

    expect(mcpOps).toHaveLength(1);
    expect(mcpOps[0]).toEqual({ type: 'add', name: 'test-server' });
  });

  it('non-main group cannot add an MCP server', async () => {
    const mcpOps: Array<{ type: string; name: string }> = [];
    const mcpDeps = {
      ...deps,
      addMcpServer: async (name: string, config: any) => { mcpOps.push({ type: 'add', name }); },
      removeMcpServer: async (name: string) => { mcpOps.push({ type: 'remove', name }); },
      restartMcpServer: async (name: string) => { mcpOps.push({ type: 'restart', name }); },
      restartAllMcpServers: async () => { mcpOps.push({ type: 'restart_all', name: '*' }); },
    };

    await processTaskIpc(
      {
        type: 'add_mcp_server',
        name: 'test-server',
        transport: 'http',
        url: 'http://localhost:3000/mcp',
      },
      'other-group',
      false,
      mcpDeps,
    );

    expect(mcpOps).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ipc-auth.test.ts`
Expected: FAIL — `addMcpServer` not in IpcDeps type

**Step 3: Update IpcDeps and processTaskIpc**

Add to `IpcDeps` interface in `src/ipc.ts`:

```typescript
export interface IpcDeps {
  // ... existing fields ...
  addMcpServer?: (name: string, config: { transport: string; command?: string; args?: string[]; url?: string }) => void;
  removeMcpServer?: (name: string) => void;
  restartMcpServer?: (name: string) => void;
  restartAllMcpServers?: () => void;
}
```

Add new data type fields to `processTaskIpc`'s data parameter type:

```typescript
// Add to the data type:
transport?: string;
url?: string;
```

Add new cases to the switch in `processTaskIpc`:

```typescript
case 'add_mcp_server':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized add_mcp_server attempt blocked');
    break;
  }
  if (data.name && deps.addMcpServer) {
    deps.addMcpServer(data.name, {
      transport: data.transport || 'stdio',
      command: data.command,
      args: data.args ? (Array.isArray(data.args) ? data.args : [data.args]) : [],
      url: data.url,
    });
    logger.info({ name: data.name, sourceGroup }, 'MCP server added via IPC');
  }
  break;

case 'remove_mcp_server':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized remove_mcp_server attempt blocked');
    break;
  }
  if (data.name && deps.removeMcpServer) {
    deps.removeMcpServer(data.name);
    logger.info({ name: data.name, sourceGroup }, 'MCP server removed via IPC');
  }
  break;

case 'restart_mcp_server':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized restart_mcp_server attempt blocked');
    break;
  }
  if (data.name && deps.restartMcpServer) {
    deps.restartMcpServer(data.name);
    logger.info({ name: data.name, sourceGroup }, 'MCP server restarted via IPC');
  }
  break;

case 'restart_all_mcp_servers':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized restart_all_mcp_servers attempt blocked');
    break;
  }
  if (deps.restartAllMcpServers) {
    deps.restartAllMcpServers();
    logger.info({ sourceGroup }, 'All MCP servers restart requested via IPC');
  }
  break;
```

**Step 4: Run tests**

Run: `npx vitest run src/ipc-auth.test.ts`
Expected: PASS

**Step 5: Commit**

```
jj describe -m "feat: handle MCP server management IPC on host side"
jj new
```

---

### Task 8: Wire IPC deps in index.ts and add McpBridgeManager methods

**Files:**
- Modify: `src/index.ts:521-532` (startIpcWatcher deps)
- Modify: `src/mcp-bridge-manager.ts` (add addServer/removeServer)
- Modify: `src/mcp-registry.ts` (saveRegistry used by addServer)

**Step 1: Add addServer/removeServer to McpBridgeManager**

```typescript
addServer(name: string, config: { transport: string; command?: string; args?: string[]; url?: string }): void {
  const registry = this.loadRegistrySafe();
  if (!registry) return;

  if (registry.servers[name]) {
    logger.warn({ name }, 'MCP server already exists in registry');
    return;
  }

  let serverConfig: ServerConfig;
  if (config.transport === 'http' && config.url) {
    serverConfig = { transport: 'http', url: config.url, enabled: true };
  } else {
    serverConfig = {
      transport: 'stdio',
      command: config.command || 'node',
      args: config.args || [],
      port: findNextPort(registry),
      enabled: true,
    };
  }

  registry.servers[name] = serverConfig;
  saveRegistry(this.registryPath, registry);

  if (serverConfig.transport === 'stdio') {
    this.startStdioServer(name, serverConfig);
  } else {
    this.httpServers.set(name, { url: serverConfig.url });
  }

  logger.info({ name, config: serverConfig }, 'MCP server added and started');
}

removeServer(name: string): void {
  this.stopServer(name);

  const registry = this.loadRegistrySafe();
  if (!registry) return;

  delete registry.servers[name];
  saveRegistry(this.registryPath, registry);

  logger.info({ name }, 'MCP server removed from registry');
}
```

Import `findNextPort, saveRegistry` from `./mcp-registry.js`.

**Step 2: Wire deps in index.ts**

Update `startIpcWatcher` call in `main()`:

```typescript
startIpcWatcher({
  // ... existing deps ...
  addMcpServer: mcpBridgeManager
    ? (name, config) => mcpBridgeManager!.addServer(name, config)
    : undefined,
  removeMcpServer: mcpBridgeManager
    ? (name) => mcpBridgeManager!.removeServer(name)
    : undefined,
  restartMcpServer: mcpBridgeManager
    ? (name) => mcpBridgeManager!.restartServer(name)
    : undefined,
  restartAllMcpServers: mcpBridgeManager
    ? () => { mcpBridgeManager!.stopAll(); mcpBridgeManager!.start(); }
    : undefined,
});
```

**Step 3: Build and run all tests**

Run: `npm run build && npx vitest run`
Expected: All tests pass.

**Step 4: Commit**

```
jj describe -m "feat: wire MCP server management IPC into main startup"
jj new
```

---

### Task 9: Update allowedTools for dynamic MCP servers

**Files:**
- Modify: `container/agent-runner/src/index.ts:426-436`

**Step 1: Add nanoclaw MCP management tools to allowedTools**

The new IPC tools (`list_mcp_servers`, `add_mcp_server`, etc.) are part of the `nanoclaw` MCP server, so they're already covered by `'mcp__nanoclaw__*'` in `allowedTools`. No change needed for those.

However, dynamically added MCP servers need their tool wildcards. Update the `allowedTools` construction:

```typescript
// Load MCP servers once for both config and allowedTools
const remoteMcpServers = loadMcpServers();
const mcpWildcards = Object.keys(remoteMcpServers).map(name => `mcp__${name}__*`);

// In query options:
allowedTools: [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  ...mcpWildcards,
],
mcpServers: {
  nanoclaw: { /* ... same as before ... */ },
  ...remoteMcpServers,
},
```

**Step 2: Build agent runner**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```
jj describe -m "feat: dynamic allowedTools for MCP servers from snapshot"
jj new
```

---

### Task 10: Clean up old mcp-bridge.ts and config

**Files:**
- Delete: `src/mcp-bridge.ts`
- Modify: `src/config.ts` (remove MCP_BRIDGE_PORT)

**Step 1: Remove old mcp-bridge.ts**

Delete `src/mcp-bridge.ts` — it's fully replaced by `mcp-bridge-manager.ts`.

**Step 2: Clean up config.ts**

Remove `MCP_BRIDGE_PORT` export and its env var reading. Keep `MCP_BRIDGE_ENABLED` and `MCP_BRIDGE_HOST` (still used for the enable flag and host override).

Remove `MCP_BRIDGE_PORT` from the `envConfig` call and from `container-runner.ts` imports.

**Step 3: Build and run all tests**

Run: `npm run build && npx vitest run`
Expected: All pass. No references to old McpBridge or MCP_BRIDGE_PORT remain.

**Step 4: Commit**

```
jj describe -m "chore: remove old McpBridge, clean up MCP config"
jj new
```

---

### Task 11: End-to-end verification

**Step 1: Rebuild container**

Run: `./container/build.sh`

**Step 2: Verify registry is read correctly**

Run: `npm run dev` (or `npm run build && node dist/index.js`)
Check logs for: `MCP bridge started` for apple-events on port 7891.

**Step 3: Test from Telegram**

Send a message to the agent and verify apple-events tools still work (e.g., list calendar events).

**Step 4: Verify IPC tools are available**

Ask the agent to `list_mcp_servers` — it should show the apple-events server.

**Step 5: Final commit**

```
jj describe -m "feat: MCP server registry — agents can manage their own MCP services"
jj new
```
