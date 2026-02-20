import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { logger } from './logger.js';

// Resolve paths relative to the running node binary so they work under launchd
// (where PATH is minimal and won't include /opt/homebrew/opt/node@22/bin).
// supergateway and mcp-server-apple-events are project dependencies — run them
// via the known node binary to avoid shebang resolution failures under launchd's minimal PATH.
// mcp-server-apple-events also requires a pre-compiled Swift binary (EventKitCLI);
// run `node node_modules/mcp-server-apple-events/scripts/build-swift.mjs` from the package dir after install.
const supergatewayScript = join(process.cwd(), 'node_modules', 'supergateway', 'dist', 'index.js');
const mcpServerAppleEventsScript = join(process.cwd(), 'node_modules', 'mcp-server-apple-events', 'dist', 'index.js');

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
      [supergatewayScript, '--stdio', `${process.execPath} ${mcpServerAppleEventsScript}`, '--port', String(this.port), '--outputTransport', 'streamableHttp'],
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
