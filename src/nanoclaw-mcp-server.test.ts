import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeIpcFile, resolveIpcDir } from './nanoclaw-mcp-server.js';

describe('nanoclaw-mcp-server IPC writes', () => {
  it('resolveIpcDir uses NANOCLAW_IPC_DIR when set', () => {
    expect(resolveIpcDir({ NANOCLAW_IPC_DIR: '/tmp/x' })).toBe('/tmp/x');
  });

  it('resolveIpcDir falls back to /workspace/ipc when unset', () => {
    expect(resolveIpcDir({})).toBe('/workspace/ipc');
  });

  it('writeIpcFile writes an atomically-renamed JSON file into the target dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ipc-'));
    const name = writeIpcFile(dir, { type: 'message', text: 'hi' });
    const written = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
    expect(written).toMatchObject({ type: 'message', text: 'hi' });
    expect(fs.existsSync(path.join(dir, `${name}.tmp`))).toBe(false);
  });
});
