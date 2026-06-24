import { describe, it, expect } from 'vitest';

import { buildClaudeArgs } from './host-claude-runner.js';

describe('buildClaudeArgs', () => {
  it('uses print + stream-json + verbose', () => {
    const a = buildClaudeArgs({});
    expect(a).toContain('-p');
    expect(a.join(' ')).toContain('--output-format stream-json');
    expect(a).toContain('--verbose');
  });
  it('runs unattended via bypassPermissions without strict mcp config', () => {
    const a = buildClaudeArgs({}).join(' ');
    expect(a).toContain('--permission-mode bypassPermissions');
    // No --strict-mcp-config: isolation (CLAUDE_CONFIG_DIR) + cwd auto-load of
    // the project .mcp.json handle MCP. --strict without --mcp-config would load
    // zero servers and break send_message.
    expect(a).not.toContain('--strict-mcp-config');
  });
  it('adds --resume only when a sessionId is provided', () => {
    expect(buildClaudeArgs({}).join(' ')).not.toContain('--resume');
    expect(buildClaudeArgs({ sessionId: 'abc' })).toEqual(
      expect.arrayContaining(['--resume', 'abc']),
    );
  });
});
