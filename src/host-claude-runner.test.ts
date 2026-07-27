import { describe, it, expect } from 'vitest';

import { buildClaudeArgs, isStaleSessionError } from './host-claude-runner.js';

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
  it('adds --add-dir <projectRoot> only when a projectRoot is provided', () => {
    expect(buildClaudeArgs({}).join(' ')).not.toContain('--add-dir');
    const a = buildClaudeArgs({ projectRoot: '/abs/root' });
    // --add-dir must be immediately followed by the project root path.
    expect(a).toEqual(expect.arrayContaining(['--add-dir', '/abs/root']));
    expect(a[a.indexOf('--add-dir') + 1]).toBe('/abs/root');
    // Core argv assertions still hold alongside --add-dir.
    expect(a).toContain('-p');
    expect(a.join(' ')).toContain('--output-format stream-json');
    expect(a).toContain('--permission-mode bypassPermissions'.split(' ')[0]);
    expect(a.join(' ')).toContain('--permission-mode bypassPermissions');
  });
});

describe('isStaleSessionError', () => {
  it('matches the claude CLI stale-session message', () => {
    expect(
      isStaleSessionError(
        'No conversation found with session ID: 0b1f4a2e-1c33-4d9a-9f2e-77aa1b2c3d4e',
      ),
    ).toBe(true);
  });

  it('matches case-insensitively and when embedded in surrounding log noise', () => {
    expect(
      isStaleSessionError(
        '[DEBUG] starting\nno conversation found with session id: abc\n[DEBUG] exiting\n',
      ),
    ).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isStaleSessionError('')).toBe(false);
    expect(isStaleSessionError('Error: connection reset by peer')).toBe(false);
    expect(isStaleSessionError('Invalid API key')).toBe(false);
    // A session id appearing in ordinary output must not trip the check.
    expect(isStaleSessionError('resuming session ID: abc')).toBe(false);
  });
});
