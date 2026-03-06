import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { McpBridgeManager } from './mcp-bridge-manager.js';
import type { Registry } from './mcp-registry.js';

let tmpDir: string;
let manager: McpBridgeManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mcp-bridge-test-'));
});

afterEach(async () => {
  manager?.stopAll();
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeRegistry(registry: Registry): Promise<string> {
  const registryPath = join(tmpDir, 'registry.json');
  await writeFile(registryPath, JSON.stringify(registry, null, 2));
  return registryPath;
}

describe('listServers', () => {
  it('returns servers from registry', async () => {
    const registryPath = await writeRegistry({
      servers: {
        'my-http': {
          transport: 'http',
          url: 'http://localhost:9000/mcp',
          enabled: true,
        },
        'my-http-disabled': {
          transport: 'http',
          url: 'http://localhost:9001/mcp',
          enabled: false,
        },
      },
    });

    manager = new McpBridgeManager(registryPath);
    await manager.start();

    const statuses = await manager.listServers();
    expect(statuses).toHaveLength(2);

    const httpServer = statuses.find((s) => s.name === 'my-http');
    expect(httpServer).toBeDefined();
    expect(httpServer!.transport).toBe('http');
    expect(httpServer!.enabled).toBe(true);
    expect(httpServer!.running).toBe(true);
    expect(httpServer!.url).toBe('http://localhost:9000/mcp');

    const disabled = statuses.find((s) => s.name === 'my-http-disabled');
    expect(disabled).toBeDefined();
    expect(disabled!.enabled).toBe(false);
    expect(disabled!.running).toBe(false);
  });

  it('returns empty for missing registry', async () => {
    const registryPath = join(tmpDir, 'nonexistent.json');
    manager = new McpBridgeManager(registryPath);
    await manager.start();

    const statuses = await manager.listServers();
    expect(statuses).toHaveLength(0);
  });
});

describe('getServerUrls', () => {
  it('returns URLs for enabled HTTP servers only', async () => {
    const registryPath = await writeRegistry({
      servers: {
        'http-a': {
          transport: 'http',
          url: 'http://remote-host:8080/mcp',
          enabled: true,
        },
        'http-b': {
          transport: 'http',
          url: 'http://remote-host:8081/mcp',
          enabled: true,
        },
      },
    });

    manager = new McpBridgeManager(registryPath);
    await manager.start();

    const urls = manager.getServerUrls('192.168.64.1');
    expect(urls['http-a']).toEqual({ url: 'http://remote-host:8080/mcp' });
    expect(urls['http-b']).toEqual({ url: 'http://remote-host:8081/mcp' });
  });

  it('excludes disabled servers', async () => {
    const registryPath = await writeRegistry({
      servers: {
        'http-enabled': {
          transport: 'http',
          url: 'http://remote:8080/mcp',
          enabled: true,
        },
        'http-disabled': {
          transport: 'http',
          url: 'http://remote:8081/mcp',
          enabled: false,
        },
      },
    });

    manager = new McpBridgeManager(registryPath);
    await manager.start();

    const urls = manager.getServerUrls('192.168.64.1');
    expect(urls['http-enabled']).toEqual({ url: 'http://remote:8080/mcp' });
    expect(urls['http-disabled']).toBeUndefined();
  });
});
