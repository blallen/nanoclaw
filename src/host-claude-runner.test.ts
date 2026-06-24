import { describe, it, expect } from 'vitest';

import { buildClaudeArgs } from './host-claude-runner.js';

describe('buildClaudeArgs', () => {
  it('uses print + stream-json + verbose', () => {
    const a = buildClaudeArgs({});
    expect(a).toContain('-p');
    expect(a.join(' ')).toContain('--output-format stream-json');
    expect(a).toContain('--verbose');
  });
  it('runs unattended via bypassPermissions and strict mcp config', () => {
    const a = buildClaudeArgs({}).join(' ');
    expect(a).toContain('--permission-mode bypassPermissions');
    expect(a).toContain('--strict-mcp-config');
  });
  it('adds --resume only when a sessionId is provided', () => {
    expect(buildClaudeArgs({}).join(' ')).not.toContain('--resume');
    expect(buildClaudeArgs({ sessionId: 'abc' })).toEqual(
      expect.arrayContaining(['--resume', 'abc']),
    );
  });
});
