import { readFile, writeFile, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { logger } from './logger.js';

// --- Types ---

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

// --- Loader / Writer ---

const DEFAULT_BASE_PORT = 7891;

export async function loadRegistry(registryPath: string): Promise<Registry> {
  const raw = await readFile(registryPath, 'utf-8');
  const registry: Registry = JSON.parse(raw);

  // Validate no duplicate ports among stdio servers
  const ports = new Map<number, string>();
  for (const [name, config] of Object.entries(registry.servers)) {
    if (config.transport === 'stdio') {
      const existing = ports.get(config.port);
      if (existing) {
        throw new Error(
          `Duplicate port ${config.port}: servers "${existing}" and "${name}"`,
        );
      }
      ports.set(config.port, name);
    }
  }

  logger.debug({ servers: Object.keys(registry.servers) }, 'Registry loaded');
  return registry;
}

export async function saveRegistry(
  registryPath: string,
  registry: Registry,
): Promise<void> {
  const tmp = join(dirname(registryPath), `.registry-${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  await rename(tmp, registryPath);
  logger.debug('Registry saved');
}

export function findNextPort(
  registry: Registry,
  basePort: number = DEFAULT_BASE_PORT,
): number {
  const usedPorts = new Set<number>();
  for (const config of Object.values(registry.servers)) {
    if (config.transport === 'stdio') {
      usedPorts.add(config.port);
    }
  }

  let port = basePort;
  while (usedPorts.has(port)) {
    port++;
  }
  return port;
}
