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
