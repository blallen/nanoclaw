import { describe, expect, it } from 'vitest';

import { ClaudeStreamParser } from './claude-stream.js';

const SESSION_ID = 'a65e90d5-bfd5-4b50-9428-6500f5bc0d03';

const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: '/path',
  session_id: SESSION_ID,
  model: 'claude-opus-4-8[1m]',
  permissionMode: 'bypassPermissions',
});

const ASSISTANT = JSON.stringify({
  type: 'assistant',
  message: {
    model: 'claude-opus-4-8',
    id: 'msg_01MwubZjSxqmf24',
    role: 'assistant',
    content: [{ type: 'text', text: 'HELLO' }],
    stop_reason: null,
  },
  parent_tool_use_id: null,
  session_id: SESSION_ID,
  uuid: '01023794-6d1a',
  request_id: 'req_011',
});

const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 3276,
  num_turns: 1,
  result: 'HELLO',
  session_id: SESSION_ID,
  total_cost_usd: 0.114151,
});

const RATE_LIMIT = JSON.stringify({
  type: 'rate_limit_event',
  some: 'payload',
});

describe('ClaudeStreamParser', () => {
  it('captures sessionId from the init event', () => {
    const parser = new ClaudeStreamParser();
    parser.push(INIT + '\n');
    expect(parser.sessionId).toBeTruthy();
    expect(parser.sessionId).toBe(SESSION_ID);
  });

  it('emits assistant text', () => {
    const parser = new ClaudeStreamParser();
    const texts: string[] = [];
    parser.on('text', (t) => texts.push(t));
    parser.push(ASSISTANT + '\n');
    expect(texts.join('')).toContain('HELLO');
  });

  it('handles a JSON object split across two push() calls', () => {
    const parser = new ClaudeStreamParser();
    const texts: string[] = [];
    parser.on('text', (t) => texts.push(t));

    const mid = Math.floor(ASSISTANT.length / 2);
    parser.push(ASSISTANT.slice(0, mid));
    expect(texts).toHaveLength(0); // nothing parsed yet — line incomplete
    parser.push(ASSISTANT.slice(mid) + '\n');

    expect(texts.join('')).toContain('HELLO');
  });

  it('marks completion on the result event and captures final session id', () => {
    const parser = new ClaudeStreamParser();
    let done = false;
    parser.on('result', () => {
      done = true;
    });
    parser.push(RESULT + '\n');

    expect(done).toBe(true);
    expect(parser.sessionId).toBe(SESSION_ID);
    expect(parser.result).toBe('HELLO');
    expect(parser.isError).toBe(false);
  });

  it('ignores unknown event types without throwing or emitting text', () => {
    const parser = new ClaudeStreamParser();
    const texts: string[] = [];
    parser.on('text', (t) => texts.push(t));

    expect(() => parser.push(RATE_LIMIT + '\n')).not.toThrow();
    expect(texts).toHaveLength(0);
  });

  it('handles multiple JSON objects arriving in one chunk', () => {
    const parser = new ClaudeStreamParser();
    const texts: string[] = [];
    let done = false;
    parser.on('text', (t) => texts.push(t));
    parser.on('result', () => {
      done = true;
    });

    parser.push([INIT, ASSISTANT, RESULT].join('\n') + '\n');

    expect(parser.sessionId).toBe(SESSION_ID);
    expect(texts.join('')).toContain('HELLO');
    expect(done).toBe(true);
  });

  it('ignores non-text content items (e.g. tool_use)', () => {
    const parser = new ClaudeStreamParser();
    const texts: string[] = [];
    parser.on('text', (t) => texts.push(t));

    const withToolUse = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} },
          { type: 'text', text: 'after tool' },
        ],
      },
      session_id: SESSION_ID,
    });

    parser.push(withToolUse + '\n');
    expect(texts).toEqual(['after tool']);
  });

  it('tolerates a non-JSON line without throwing', () => {
    const parser = new ClaudeStreamParser();
    expect(() => parser.push('not json at all\n')).not.toThrow();
    expect(parser.sessionId).toBeUndefined();
  });

  it('marks isError when result subtype is not success', () => {
    const parser = new ClaudeStreamParser();
    const errResult = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: null,
      session_id: SESSION_ID,
    });
    parser.push(errResult + '\n');
    expect(parser.isError).toBe(true);
  });
});
