import { describe, it, expect } from 'vitest';
import { chooseRunner } from './runner-selection.js';
import { runHostClaudeAgent } from './host-claude-runner.js';
import { runContainerAgent } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const mk = (folder: string): RegisteredGroup => ({ name: folder, folder } as RegisteredGroup);

describe('chooseRunner', () => {
  it('returns the host runner for the main group', () => {
    expect(chooseRunner(mk('main'))).toBe(runHostClaudeAgent);
  });
  it('returns the container runner for non-main groups', () => {
    expect(chooseRunner(mk('family-chat'))).toBe(runContainerAgent);
  });
});
