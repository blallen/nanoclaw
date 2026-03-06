import { spawn, ChildProcess } from 'child_process';
import { join, sep } from 'path';
import { watch, FSWatcher } from 'fs';
import { logger } from './logger.js';
import {
  loadRegistry,
  saveRegistry,
  findNextPort,
  Registry,
  ServerConfig,
  StdioServerConfig,
  HttpServerConfig,
} from './mcp-registry.js';

export interface ServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  running: boolean;
  url?: string;
  port?: number;
}

interface StdioServerState {
  proc: ChildProcess;
  config: StdioServerConfig;
  stopping: boolean;
  restartDelay: number;
  restartTimer?: ReturnType<typeof setTimeout>;
}

interface HttpServerState {
  config: HttpServerConfig;
}

const supergatewayScript = join(
  process.cwd(),
  'node_modules',
  'supergateway',
  'dist',
  'index.js',
);

export class McpBridgeManager {
  private readonly registryPath: string;
  private readonly mcpServersDir: string;
  private stdioServers = new Map<string, StdioServerState>();
  private httpServers = new Map<string, HttpServerState>();
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(registryPath: string) {
    this.registryPath = registryPath;
    // mcp-servers/ is the parent directory of registry.json
    this.mcpServersDir = join(registryPath, '..');
  }

  async start(): Promise<void> {
    let registry: Registry;
    try {
      registry = await loadRegistry(this.registryPath);
    } catch (err) {
      logger.warn({ err }, 'No MCP registry found, skipping bridge start');
      this.startWatcher();
      return;
    }

    for (const [name, config] of Object.entries(registry.servers)) {
      if (!config.enabled) continue;
      this.startOneServer(name, config);
    }

    this.startWatcher();
    logger.info(
      { servers: Object.keys(registry.servers) },
      'McpBridgeManager started',
    );
  }

  async startServer(name: string): Promise<void> {
    const registry = await loadRegistry(this.registryPath);
    const config = registry.servers[name];
    if (!config) {
      logger.warn({ name }, 'Server not found in registry');
      return;
    }
    this.startOneServer(name, config);
  }

  stopServer(name: string): void {
    this.stopOneStdio(name);
    this.httpServers.delete(name);
  }

  async restartServer(name: string): Promise<void> {
    this.stopServer(name);
    await this.startServer(name);
  }

  stopAll(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;

    for (const name of this.stdioServers.keys()) {
      this.stopOneStdio(name);
    }
    this.httpServers.clear();
    logger.info('McpBridgeManager stopped all servers');
  }

  async listServers(): Promise<ServerStatus[]> {
    let registry: Registry;
    try {
      registry = await loadRegistry(this.registryPath);
    } catch {
      return [];
    }

    const statuses: ServerStatus[] = [];
    for (const [name, config] of Object.entries(registry.servers)) {
      if (config.transport === 'stdio') {
        const state = this.stdioServers.get(name);
        statuses.push({
          name,
          transport: 'stdio',
          enabled: config.enabled,
          running: state ? !state.proc.killed : false,
          port: config.port,
        });
      } else {
        statuses.push({
          name,
          transport: 'http',
          enabled: config.enabled,
          running: config.enabled, // HTTP servers are "running" if enabled
          url: config.url,
        });
      }
    }
    return statuses;
  }

  getServerUrls(hostIp: string): Record<string, { url: string }> {
    const urls: Record<string, { url: string }> = {};

    for (const [name, state] of this.stdioServers.entries()) {
      if (!state.stopping) {
        urls[name] = {
          url: `http://${hostIp}:${state.config.port}/mcp`,
        };
      }
    }

    for (const [name, state] of this.httpServers.entries()) {
      if (state.config.enabled) {
        urls[name] = { url: state.config.url };
      }
    }

    return urls;
  }

  isAnyRunning(): boolean {
    for (const state of this.stdioServers.values()) {
      if (!state.proc.killed) return true;
    }
    return this.httpServers.size > 0;
  }

  async addServer(name: string, config: { transport: string; command?: string; args?: string[]; url?: string }): Promise<void> {
    const registry = await this.loadRegistrySafe();
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
    await saveRegistry(this.registryPath, registry);

    this.startOneServer(name, serverConfig);
    logger.info({ name, config: serverConfig }, 'MCP server added and started');
  }

  async removeServer(name: string): Promise<void> {
    this.stopServer(name);

    const registry = await this.loadRegistrySafe();
    if (!registry) return;

    delete registry.servers[name];
    await saveRegistry(this.registryPath, registry);

    logger.info({ name }, 'MCP server removed from registry');
  }

  // --- Private ---

  private async loadRegistrySafe(): Promise<Registry | null> {
    try {
      return await loadRegistry(this.registryPath);
    } catch (err) {
      logger.warn({ err }, 'Failed to load MCP registry');
      return null;
    }
  }

  private startOneServer(name: string, config: ServerConfig): void {
    if (config.transport === 'stdio') {
      this.spawnStdioServer(name, config);
    } else {
      this.httpServers.set(name, { config });
      logger.info({ name, url: config.url }, 'HTTP MCP server registered');
    }
  }

  private spawnStdioServer(name: string, config: StdioServerConfig): void {
    // Stop existing if any
    this.stopOneStdio(name);

    const command =
      config.command === 'node' ? process.execPath : config.command;
    const stdioCmd = `${command} ${config.args.join(' ')}`;

    const proc = spawn(
      process.execPath,
      [
        supergatewayScript,
        '--stdio',
        stdioCmd,
        '--port',
        String(config.port),
        '--outputTransport',
        'streamableHttp',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const state: StdioServerState = {
      proc,
      config,
      stopping: false,
      restartDelay: 1000,
    };

    this.stdioServers.set(name, state);

    proc.stdout?.on('data', (d: Buffer) =>
      logger.debug({ bridge: name }, d.toString().trim()),
    );
    proc.stderr?.on('data', (d: Buffer) =>
      logger.debug({ bridge: name }, d.toString().trim()),
    );

    proc.on('exit', (code: number | null) => {
      if (state.stopping) return;
      logger.warn(
        { name, code, retryIn: state.restartDelay },
        'MCP bridge exited unexpectedly, restarting',
      );
      state.restartTimer = setTimeout(() => {
        state.restartDelay = Math.min(state.restartDelay * 2, 30000);
        this.spawnStdioServer(name, config);
      }, state.restartDelay);
    });

    logger.info({ name, port: config.port }, 'Stdio MCP bridge started');
  }

  private stopOneStdio(name: string): void {
    const state = this.stdioServers.get(name);
    if (!state) return;

    state.stopping = true;
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
    }
    state.proc.kill();
    this.stdioServers.delete(name);
    logger.info({ name }, 'Stdio MCP bridge stopped');
  }

  private startWatcher(): void {
    try {
      this.watcher = watch(
        this.mcpServersDir,
        { recursive: true },
        (_event, filename) => {
          if (!filename) return;
          this.debouncedOnChange(filename);
        },
      );

      this.watcher.on('error', (err) => {
        logger.warn({ err }, 'MCP servers watcher error');
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to start mcp-servers watcher');
    }
  }

  private debouncedOnChange(filename: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.handleChange(filename).catch((err) => {
        logger.error({ err, filename }, 'Error handling mcp-servers change');
      });
    }, 500);
  }

  private async handleChange(filename: string): Promise<void> {
    if (filename === 'registry.json') {
      logger.info('Registry changed, reconciling servers');
      await this.reconcile();
    } else {
      // File changed in a server subdirectory — restart that server
      const serverName = filename.split(sep)[0];
      if (serverName && this.stdioServers.has(serverName)) {
        logger.info({ serverName }, 'Server files changed, restarting');
        await this.restartServer(serverName);
      }
    }
  }

  private async reconcile(): Promise<void> {
    let registry: Registry;
    try {
      registry = await loadRegistry(this.registryPath);
    } catch (err) {
      logger.warn({ err }, 'Failed to load registry during reconciliation');
      return;
    }

    const desired = new Set<string>();

    for (const [name, config] of Object.entries(registry.servers)) {
      if (config.enabled) {
        desired.add(name);
        // Start or update server
        if (config.transport === 'stdio') {
          const existing = this.stdioServers.get(name);
          if (!existing || existing.proc.killed) {
            this.spawnStdioServer(name, config);
          }
        } else {
          this.httpServers.set(name, { config });
        }
      }
    }

    // Stop servers that are no longer desired
    for (const name of this.stdioServers.keys()) {
      if (!desired.has(name)) {
        this.stopOneStdio(name);
      }
    }
    for (const name of this.httpServers.keys()) {
      if (!desired.has(name)) {
        this.httpServers.delete(name);
      }
    }
  }
}
